import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { publish } from '../../lib/queue.js';
import { QUEUE_NAMES, EVENT_TYPES, SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const assignSchema = z.object({
  lead_id: z.string().uuid(),
  assigned_to: z.string().uuid(),
  assignment_type: z.enum(['assign', 'reassign', 'auto_assign', 'refer']).default('reassign'),
  reason: z.string().optional(),
});

// History — scoped under /lead-assignments
router.get('/lead/:leadId', validate({ params: z.object({ leadId: z.string().uuid() }) }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT la.*, u_to.name AS assigned_to_name, u_from.name AS from_user_name, u_by.name AS assigned_by_name
         FROM lead_assignments la
         LEFT JOIN users u_to ON u_to.id = la.assigned_to
         LEFT JOIN users u_from ON u_from.id = la.from_user_id
         LEFT JOIN users u_by ON u_by.id = la.assigned_by
        WHERE la.lead_id = $1
        ORDER BY la.created_at DESC`,
      [req.params.leadId],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// (Re)assign a lead
router.post(
  '/',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER),
  validate({ body: assignSchema }),
  async (req, res, next) => {
    try {
      const { lead_id, assigned_to, assignment_type, reason } = req.body;

      // Sales-manager scope: the new owner must be inside this manager's team
      // hierarchy. Admins can reassign to any active counsellor.
      if (req.user.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
        const { teamHierarchy } = await import('../users/repo.js');
        const teamIds = await teamHierarchy(req.tenant, req.user.id);
        if (!teamIds.includes(assigned_to)) {
          const { forbidden } = await import('../../lib/errors.js');
          throw forbidden('You can only reassign to counsellors in your team');
        }
      }

      const result = await tenantTx(req.tenant, async (client) => {
        const { rows: leadRows } = await client.query(`SELECT assigned_to FROM leads WHERE id = $1 AND deleted_at IS NULL`, [lead_id]);
        if (!leadRows[0]) throw notFound('Lead not found');
        const from_user_id = leadRows[0].assigned_to;
        await client.query(`UPDATE lead_assignments SET is_active = false, status = 'closed' WHERE lead_id = $1 AND is_active`, [lead_id]);
        const { rows } = await client.query(
          `INSERT INTO lead_assignments (lead_id, from_user_id, assigned_to, assigned_by, assignment_type, reason, is_active, status)
           VALUES ($1,$2,$3,$4,$5,$6,true,'open') RETURNING *`,
          [lead_id, from_user_id, assigned_to, req.user.id, assignment_type, reason ?? null],
        );
        // Snap manager_id to the new counsellor's primary manager so the
        // hierarchy chip on the LeadCard reflects reality. Same logic that
        // bulkAssign uses.
        const { rows: mgrRow } = await client.query(`SELECT manager_id FROM users WHERE id = $1`, [assigned_to]);
        const newManagerId = mgrRow[0]?.manager_id ?? null;
        await client.query(
          `UPDATE leads SET assigned_to = $2, manager_id = $3, last_activity_at = now() WHERE id = $1`,
          [lead_id, assigned_to, newManagerId],
        );
        await client.query(
          `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [lead_id, req.user.id, assignment_type, `Lead ${assignment_type}`, JSON.stringify({ from: from_user_id, to: assigned_to, reason: reason ?? null })],
        );
        return rows[0];
      });
      await publish(QUEUE_NAMES.EVENTS, EVENT_TYPES.LEAD_ASSIGNED, {
        type: EVENT_TYPES.LEAD_ASSIGNED,
        tenantId: req.tenant.id,
        occurredAt: new Date().toISOString(),
        actorUserId: req.user.id,
        entityType: 'lead',
        entityId: lead_id,
        payload: { assigned_to, assignment_type },
      });
      // Real-time: notify the new counsellor + their managers + admins,
      // AND the previous counsellor (so they see "lead moved away from you").
      const { notifyLeadChange } = await import('../../lib/socket.js');
      notifyLeadChange({
        tenant: req.tenant,
        lead: { id: lead_id, assigned_to },
        type: 'lead.reassigned',
        actor_id: req.user.id,
        previous_owner_id: result.from_user_id ?? null,
        payload: { from_user_id: result.from_user_id, assignment_type, reason: reason ?? null },
      }).catch(() => {});
      res.status(201).json({ data: result, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

export default router;
