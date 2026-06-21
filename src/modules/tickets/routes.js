// In-tenant support tickets.
//
// Routing rules (the FE picker is *informational* — the raiser tags a
// reporting-chain colleague, but the ticket also fans out to the audiences
// below for visibility):
//   - counsellor      → primary + secondary managers, all super_admins
//   - manager         → all super_admins
//   - account_manager → all super_admins (no team, no reporting manager —
//                       tickets route straight to org admins)
//   - super_admin     → all super_admins (Stage 2 will replicate to PO too)
//
// The picker options come from /tickets/contacts: each role's contacts are
// limited to their reporting chain (managers above + team below + admins).
//
// Status enum stays open | in_progress | resolved | closed (unchanged).
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { sysQuery } from '../../db/system.js';
import { notFound, forbidden } from '../../lib/errors.js';
import { teamHierarchy, getManagerIds } from '../users/repo.js';
import { SYSTEM_TENANT_ROLES, TEAM_SCOPED_MANAGER_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const createSchema = z.object({
  subject: z.string().min(1),
  category: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  description: z.string().optional(),
  phone: z.string().optional(),
  target_user_id: z.string().uuid().optional(),
  attachments: z.array(z.string().uuid()).optional(),
});
const updateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  resolution_note: z.string().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
const commentSchema = z.object({ body: z.string().min(1), attachments: z.array(z.string().uuid()).optional() });
const idParam = z.object({ id: z.string().uuid() });

// Returns the set of user ids the caller is allowed to address as the
// ticket's `target_user_id`. Used by both the contacts endpoint and the
// POST validator. Always includes the caller's reporting chain.
const allowedContactIds = async (tenant, actor) => {
  const ids = new Set();
  if (actor.role === SYSTEM_TENANT_ROLES.COUNSELLOR) {
    const mgrs = await getManagerIds(tenant, actor.id);
    for (const m of mgrs) ids.add(m);
    const { rows: admins } = await tenantQuery(
      tenant,
      `SELECT id FROM users WHERE role = 'super_admin' AND deleted_at IS NULL AND is_active = true`,
    );
    for (const a of admins) ids.add(a.id);
  } else if (TEAM_SCOPED_MANAGER_ROLES.includes(actor.role)) {
    // Manager sees: their downstream team + their own managers + admins
    const team = await teamHierarchy(tenant, actor.id);
    for (const t of team) ids.add(t);
    const mgrs = await getManagerIds(tenant, actor.id);
    for (const m of mgrs) ids.add(m);
    const { rows: admins } = await tenantQuery(
      tenant,
      `SELECT id FROM users WHERE role = 'super_admin' AND deleted_at IS NULL AND is_active = true`,
    );
    for (const a of admins) ids.add(a.id);
  } else if (actor.role === SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER) {
    // Account managers are tenant-level standalone users (no team / no
    // reporting manager). Their tickets always go to org admins.
    const { rows: admins } = await tenantQuery(
      tenant,
      `SELECT id FROM users WHERE role = 'super_admin' AND deleted_at IS NULL AND is_active = true`,
    );
    for (const a of admins) ids.add(a.id);
  } else if (actor.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    // Super-admin can address every active user in the tenant; the actual
    // escalation to product-owner is automatic and lives in Stage 2.
    const { rows: all } = await tenantQuery(
      tenant,
      `SELECT id FROM users WHERE deleted_at IS NULL AND is_active = true`,
    );
    for (const u of all) ids.add(u.id);
  }
  ids.delete(actor.id); // never tag yourself
  return ids;
};

// ---- Contacts (picker options) ---------------------------------------------
router.get('/contacts', async (req, res, next) => {
  try {
    const ids = await allowedContactIds(req.tenant, req.user);
    if (!ids.size) return res.json({ data: [], meta: { requestId: req.id } });
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT id, name, email, phone, role
         FROM users
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
        ORDER BY role, name`,
      [Array.from(ids)],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---- Whoami helper for the form (autofill phone/email) ---------------------
router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT id, name, email, phone, role FROM users WHERE id = $1`,
      [req.user.id],
    );
    res.json({ data: rows[0] ?? null, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---- List ------------------------------------------------------------------
// A user sees: tickets they raised, plus tickets targeting them, plus
// (manager/super_admin) tickets raised by anyone in their downstream team.
router.get('/', async (req, res, next) => {
  try {
    const conds = ['t.deleted_at IS NULL'];
    const params = [];
    if (req.user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
      // super_admins see every ticket in the tenant — no extra filter.
    } else if (TEAM_SCOPED_MANAGER_ROLES.includes(req.user.role)) {
      const team = await teamHierarchy(req.tenant, req.user.id);
      params.push(req.user.id, team);
      conds.push(`(t.user_id = $1 OR t.target_user_id = $1 OR t.user_id = ANY($2::uuid[]))`);
    } else {
      params.push(req.user.id);
      conds.push(`(t.user_id = $1 OR t.target_user_id = $1)`);
    }
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT t.*,
              u.name  AS raised_by_name,
              u.email AS raised_by_email,
              u.role  AS raised_by_role,
              tu.name AS target_user_name,
              tu.role AS target_user_role
         FROM tickets t
         LEFT JOIN users u  ON u.id  = t.user_id
         LEFT JOIN users tu ON tu.id = t.target_user_id
        WHERE ${conds.join(' AND ')}
        ORDER BY t.created_at DESC LIMIT 500`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---- Create ----------------------------------------------------------------
router.post('/', validate({ body: createSchema }), async (req, res, next) => {
  try {
    // Validate target is in the raiser's allowed set
    if (req.body.target_user_id) {
      const allowed = await allowedContactIds(req.tenant, req.user);
      if (!allowed.has(req.body.target_user_id)) {
        throw forbidden('Target user is not in your reporting chain');
      }
    }
    // Autofill phone from user record when not provided
    let phone = req.body.phone ?? null;
    if (!phone) {
      const { rows } = await tenantQuery(req.tenant, `SELECT phone FROM users WHERE id = $1`, [req.user.id]);
      phone = rows[0]?.phone ?? null;
    }
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO tickets (user_id, subject, category, priority, description, phone, target_user_id, attachments, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open') RETURNING *`,
      [
        req.user.id,
        req.body.subject,
        req.body.category ?? null,
        req.body.priority,
        req.body.description ?? null,
        phone,
        req.body.target_user_id ?? null,
        req.body.attachments ? JSON.stringify(req.body.attachments) : null,
      ],
    );
    const ticket = rows[0];

    // Auto-escalate to PO when a tenant super_admin raises a ticket. We
    // snapshot identity fields so the system row stays meaningful even if
    // the tenant user is later soft-deleted, and store the system row's id
    // back on the tenant row to keep status/comments in sync later.
    if (req.user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
      const { rows: meRows } = await tenantQuery(
        req.tenant,
        `SELECT name, email FROM users WHERE id = $1`,
        [req.user.id],
      );
      const me = meRows[0] ?? {};
      const { rows: sysRows } = await sysQuery(
        `INSERT INTO support_tickets
          (tenant_id, tenant_ticket_id, raised_by_user_id, raised_by_name, raised_by_email,
           raised_by_phone, raised_by_role, subject, category, priority, description, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open')
         RETURNING id`,
        [
          req.tenant.id,
          ticket.id,
          req.user.id,
          me.name ?? null,
          me.email ?? null,
          phone,
          SYSTEM_TENANT_ROLES.SUPER_ADMIN,
          ticket.subject,
          ticket.category,
          ticket.priority,
          ticket.description,
        ],
      );
      const systemTicketId = sysRows[0].id;
      await tenantQuery(
        req.tenant,
        `UPDATE tickets SET system_ticket_id = $2 WHERE id = $1`,
        [ticket.id, systemTicketId],
      );
      ticket.system_ticket_id = systemTicketId;
    }

    res.status(201).json({ data: ticket, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---- Get one ---------------------------------------------------------------
router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT t.*, u.name AS raised_by_name, u.email AS raised_by_email, u.role AS raised_by_role,
              tu.name AS target_user_name, tu.role AS target_user_role
         FROM tickets t
         LEFT JOIN users u  ON u.id  = t.user_id
         LEFT JOIN users tu ON tu.id = t.target_user_id
        WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [req.params.id],
    );
    if (!rows[0]) throw notFound('Ticket not found');
    const { rows: comments } = await tenantQuery(
      req.tenant,
      `SELECT tc.*, u.name AS user_name FROM ticket_comments tc LEFT JOIN users u ON u.id = tc.user_id WHERE ticket_id = $1 ORDER BY created_at`,
      [req.params.id],
    );
    res.json({ data: { ...rows[0], comments }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---- Status update ---------------------------------------------------------
router.patch('/:id', validate({ params: idParam, body: updateSchema }), async (req, res, next) => {
  try {
    const { rows: existing } = await tenantQuery(
      req.tenant,
      `SELECT user_id, target_user_id, status FROM tickets WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!existing[0]) throw notFound('Ticket not found');
    // Only the assignee, the raiser, or a super_admin may update.
    const isPrivileged =
      req.user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN ||
      req.user.id === existing[0].target_user_id ||
      req.user.id === existing[0].user_id;
    if (!isPrivileged) throw forbidden('Not authorized to update this ticket');

    const fields = [];
    const params = [];
    let i = 1;
    if (req.body.status !== undefined) {
      fields.push(`status = $${i}`); params.push(req.body.status); i += 1;
      if (req.body.status === 'resolved' || req.body.status === 'closed') {
        fields.push(`resolved_at = COALESCE(resolved_at, now())`);
      } else {
        fields.push(`resolved_at = NULL`);
      }
    }
    if (req.body.resolution_note !== undefined) {
      fields.push(`resolution_note = $${i}`); params.push(req.body.resolution_note); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE tickets SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`,
      params,
    );
    const updated = rows[0];

    // Mirror status/resolution_note onto the system row when this ticket
    // was escalated to PO. We mirror only the columns that just changed so
    // a tenant-side resolution_note tweak doesn't accidentally clobber a
    // PO-side one mid-flight.
    if (updated?.system_ticket_id) {
      const sysFields = [];
      const sysParams = [];
      let j = 1;
      if (req.body.status !== undefined) {
        sysFields.push(`status = $${j}`); sysParams.push(req.body.status); j += 1;
        if (req.body.status === 'resolved' || req.body.status === 'closed') {
          sysFields.push(`resolved_at = COALESCE(resolved_at, now())`);
        } else {
          sysFields.push(`resolved_at = NULL`);
        }
      }
      if (req.body.resolution_note !== undefined) {
        sysFields.push(`resolution_note = $${j}`); sysParams.push(req.body.resolution_note); j += 1;
      }
      if (sysFields.length) {
        sysParams.push(updated.system_ticket_id);
        await sysQuery(
          `UPDATE support_tickets SET ${sysFields.join(', ')} WHERE id = $${j}`,
          sysParams,
        );
      }
    }

    res.json({ data: updated, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---- Comment ---------------------------------------------------------------
router.post('/:id/comments', validate({ params: idParam, body: commentSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO ticket_comments (ticket_id, user_id, body, attachments) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user.id, req.body.body, req.body.attachments ? JSON.stringify(req.body.attachments) : null],
    );
    // Mirror to the system thread when this ticket is escalated to PO so
    // the PO sees the tenant super_admin's reply. Snapshot the author's
    // name to keep the system row self-contained.
    const { rows: parent } = await tenantQuery(
      req.tenant,
      `SELECT system_ticket_id FROM tickets WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (parent[0]?.system_ticket_id) {
      const { rows: meRows } = await tenantQuery(
        req.tenant,
        `SELECT name FROM users WHERE id = $1`,
        [req.user.id],
      );
      await sysQuery(
        `INSERT INTO support_ticket_comments (support_ticket_id, tenant_user_id, author_name, body)
         VALUES ($1, $2, $3, $4)`,
        [parent[0].system_ticket_id, req.user.id, meRows[0]?.name ?? null, req.body.body],
      );
    }
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
