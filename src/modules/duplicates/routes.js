import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES, EVENT_TYPES, QUEUE_NAMES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';
import { findDuplicates } from '../leads/repo.js';
import { publish } from '../../lib/queue.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const checkSchema = z.object({
  phone: z.string().optional(),
  email: z.string().email().optional(),
  whatsapp_number: z.string().optional(),
});

const bulkSchema = z.object({
  rows: z.array(checkSchema).min(1).max(1000),
});

const mergeSchema = z.object({
  merge_into_lead_id: z.string().uuid(),
  field_decisions: z.record(z.string(), z.string().uuid()).optional(),
  resolve_duplicate_match_id: z.string().uuid().optional(),
});

router.post('/check', validate({ body: checkSchema }), async (req, res, next) => {
  try {
    const matches = await findDuplicates(req.tenant, req.body);
    res.json({ data: matches, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/check-bulk', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: bulkSchema }), async (req, res, next) => {
  try {
    const out = [];
    for (const [i, row] of req.body.rows.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const matches = await findDuplicates(req.tenant, row);
      out.push({ row_index: i, input: row, matches });
    }
    res.json({ data: out, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT m.*,
              la.name AS lead_a_name, la.email AS lead_a_email, la.phone AS lead_a_phone,
              lb.name AS lead_b_name, lb.email AS lead_b_email, lb.phone AS lead_b_phone
         FROM lead_duplicate_matches m
         LEFT JOIN leads la ON la.id = m.lead_a_id
         LEFT JOIN leads lb ON lb.id = m.lead_b_id
        WHERE m.status = 'open'
        ORDER BY m.created_at DESC
        LIMIT 500`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:matchId/ignore', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: z.object({ matchId: z.string().uuid() }) }), async (req, res, next) => {
  try {
    await tenantQuery(
      req.tenant,
      `UPDATE lead_duplicate_matches SET status = 'ignored', reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND status = 'open'`,
      [req.params.matchId, req.user.id],
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

// Merge: move all associated records from merged → surviving, mark merged lead merged_into.
router.post('/lead/:leadId/merge', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: z.object({ leadId: z.string().uuid() }), body: mergeSchema }), async (req, res, next) => {
  try {
    const merged_lead_id = req.params.leadId;
    const surviving_lead_id = req.body.merge_into_lead_id;
    if (merged_lead_id === surviving_lead_id) throw notFound('Cannot merge a lead into itself');

    const result = await tenantTx(req.tenant, async (client) => {
      const { rows: bothRows } = await client.query(
        `SELECT id FROM leads WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [[merged_lead_id, surviving_lead_id]],
      );
      if (bothRows.length !== 2) throw notFound('One or both leads not found');

      // Transfer lead_activities, lead_notes, lead_followups, lead_assignments, message_log, calls, lead_source_attributions, lead_tags, lead_custom_values, payments, payment_links
      const transfers = [
        'UPDATE lead_activities SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE lead_notes SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE lead_followups SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE lead_assignments SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE message_log SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE calls SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE lead_source_attributions SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE lead_touches SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE payments SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE payment_links SET lead_id = $1 WHERE lead_id = $2',
      ];
      let activityCount = 0; let noteCount = 0; let messageCount = 0;
      for (const sql of transfers) {
        const r = await client.query(sql, [surviving_lead_id, merged_lead_id]);
        if (sql.includes('lead_activities')) activityCount = r.rowCount;
        if (sql.includes('lead_notes')) noteCount = r.rowCount;
        if (sql.includes('message_log')) messageCount = r.rowCount;
      }

      // Tag consolidation: insert distinct new tags.
      await client.query(
        `INSERT INTO lead_tags (lead_id, tag_id, assigned_by, assigned_at)
         SELECT $1, tag_id, assigned_by, assigned_at FROM lead_tags WHERE lead_id = $2
         ON CONFLICT DO NOTHING`,
        [surviving_lead_id, merged_lead_id],
      );
      await client.query(`DELETE FROM lead_tags WHERE lead_id = $1`, [merged_lead_id]);

      // Custom values — survivor wins on conflict.
      await client.query(
        `INSERT INTO lead_custom_values (lead_id, field_id, value, updated_at)
         SELECT $1, field_id, value, updated_at FROM lead_custom_values WHERE lead_id = $2
         ON CONFLICT (lead_id, field_id) DO NOTHING`,
        [surviving_lead_id, merged_lead_id],
      );
      await client.query(`DELETE FROM lead_custom_values WHERE lead_id = $1`, [merged_lead_id]);

      // Field decisions — copy specific fields from merged onto surviving.
      if (req.body.field_decisions) {
        for (const [field, winnerId] of Object.entries(req.body.field_decisions)) {
          if (winnerId === merged_lead_id) {
            await client.query(
              `UPDATE leads s SET ${field} = m.${field} FROM leads m WHERE s.id = $1 AND m.id = $2`,
              [surviving_lead_id, merged_lead_id],
            );
          }
        }
      }

      // Soft-delete merged lead and record merged_into.
      await client.query(
        `UPDATE leads SET merged_into_id = $1, deleted_at = now() WHERE id = $2`,
        [surviving_lead_id, merged_lead_id],
      );

      const { rows: mergeLogRows } = await client.query(
        `INSERT INTO lead_merge_log (surviving_lead_id, merged_lead_id, merged_by, field_decisions_json, activity_count_transferred, note_count_transferred, message_count_transferred)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,
        [surviving_lead_id, merged_lead_id, req.user.id, JSON.stringify(req.body.field_decisions ?? {}), activityCount, noteCount, messageCount],
      );

      if (req.body.resolve_duplicate_match_id) {
        await client.query(
          `UPDATE lead_duplicate_matches SET status = 'merged', reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
          [req.body.resolve_duplicate_match_id, req.user.id],
        );
      }

      await client.query(
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
         VALUES ($1,$2,'lead_merged',$3,$4::jsonb)`,
        [surviving_lead_id, req.user.id, 'Lead merged', JSON.stringify({ merged_from: merged_lead_id })],
      );
      return mergeLogRows[0];
    });

    await publish(QUEUE_NAMES.EVENTS, EVENT_TYPES.LEAD_MERGED, {
      type: EVENT_TYPES.LEAD_MERGED,
      tenantId: req.tenant.id,
      occurredAt: new Date().toISOString(),
      actorUserId: req.user.id,
      entityType: 'lead',
      entityId: result.surviving_lead_id,
      payload: { merged_from: result.merged_lead_id },
    });

    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
