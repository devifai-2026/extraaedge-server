import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { optimisticLock } from '../../middleware/optimisticLock.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { isValidRRule } from '../../lib/rrule.js';
import { publish } from '../../lib/queue.js';
import { EVENT_TYPES, QUEUE_NAMES, SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { teamHierarchy } from '../users/repo.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const createSchema = z.object({
  lead_id: z.string().uuid(),
  next_action_datetime: z.coerce.date(),
  comment: z.string().optional(),
  stage_id: z.string().uuid().optional(),
  sub_stage_id: z.string().uuid().optional(),
  recurrence_rule: z.string().optional(),
  recurrence_end: z.coerce.date().optional(),
});
const updateSchema = createSchema.partial().omit({ lead_id: true });
const listQuery = z.object({
  date: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  user_id: z.string().uuid().optional(),                 // creator
  assigned_user_id: z.string().uuid().optional(),        // current owner of the lead
  lead_id: z.string().uuid().optional(),
  q: z.string().optional(),                              // search by lead name / phone / email
  status: z.enum(['planned', 'done', 'missed', 'cancelled']).optional(),
  stage_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
const idParam = z.object({ id: z.string().uuid() });

router.get('/', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = ['f.deleted_at IS NULL'];
    const params = [];
    if (req.query.date) {
      params.push(req.query.date);
      params.push(req.tenant.timezone ?? 'Asia/Kolkata');
      conds.push(`DATE(f.next_action_datetime AT TIME ZONE $${params.length}) = $${params.length - 1}`);
    }
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`f.next_action_datetime >= $${params.length}::timestamptz`); }
    if (req.query.date_to)   { params.push(req.query.date_to);   conds.push(`f.next_action_datetime <= $${params.length}::timestamptz`); }
    if (req.query.user_id)          { params.push(req.query.user_id);          conds.push(`f.created_by = $${params.length}`); }
    if (req.query.assigned_user_id) { params.push(req.query.assigned_user_id); conds.push(`l.assigned_to = $${params.length}`); }
    if (req.query.lead_id)          { params.push(req.query.lead_id);          conds.push(`f.lead_id = $${params.length}`); }
    if (req.query.status)           { params.push(req.query.status);           conds.push(`f.status = $${params.length}`); }
    if (req.query.stage_id)         { params.push(req.query.stage_id);         conds.push(`l.stage_id = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      conds.push(`(l.name ILIKE $${params.length} OR l.phone ILIKE $${params.length} OR l.email::text ILIKE $${params.length})`);
    }
    if (req.user.role === SYSTEM_TENANT_ROLES.COUNSELLOR) {
      params.push(req.user.id);
      conds.push(`(f.created_by = $${params.length} OR l.assigned_to = $${params.length})`);
    } else if (req.user.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
      // Manager sees follow-ups for any lead currently owned by their team
      // (recursive manager_id chain) plus follow-ups they themselves created.
      const team = await teamHierarchy(req.tenant, req.user.id);
      params.push(team);
      params.push(req.user.id);
      conds.push(`(l.assigned_to = ANY($${params.length - 1}::uuid[]) OR f.created_by = $${params.length})`);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT f.*,
              l.name  AS lead_name,
              l.phone AS lead_phone,
              l.email AS lead_email,
              l.stage_id AS lead_stage_id,
              s.name  AS lead_stage_name,
              ss.name AS lead_sub_stage_name,
              p.name  AS lead_program_name,
              l.assigned_to AS lead_assigned_to,
              au.name AS lead_assigned_to_name,
              u.name  AS creator_name
         FROM lead_followups f
         JOIN leads l            ON l.id  = f.lead_id
         LEFT JOIN lead_stages     s   ON s.id  = l.stage_id
         LEFT JOIN lead_sub_stages ss  ON ss.id = l.sub_stage_id
         LEFT JOIN programs        p   ON p.id  = l.program_id
         LEFT JOIN users           u   ON u.id  = f.created_by
         LEFT JOIN users           au  ON au.id = l.assigned_to
         ${where}
         ORDER BY f.next_action_datetime ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Per-day follow-up counts for the calendar dot indicators. Same scope rules
// as /follow-ups (counsellor=own, manager=team via leads.assigned_to, admin=all).
router.get('/calendar', async (req, res, next) => {
  try {
    const date_from = req.query.date_from;
    const date_to   = req.query.date_to;
    const conds = ['f.deleted_at IS NULL'];
    const params = [];
    if (date_from) { params.push(date_from); conds.push(`f.next_action_datetime >= $${params.length}::timestamptz`); }
    if (date_to)   { params.push(date_to);   conds.push(`f.next_action_datetime <= $${params.length}::timestamptz`); }
    if (req.query.assigned_user_id) { params.push(req.query.assigned_user_id); conds.push(`l.assigned_to = $${params.length}`); }
    if (req.user.role === SYSTEM_TENANT_ROLES.COUNSELLOR) {
      params.push(req.user.id);
      conds.push(`(f.created_by = $${params.length} OR l.assigned_to = $${params.length})`);
    } else if (req.user.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
      const team = await teamHierarchy(req.tenant, req.user.id);
      params.push(team);
      params.push(req.user.id);
      conds.push(`(l.assigned_to = ANY($${params.length - 1}::uuid[]) OR f.created_by = $${params.length})`);
    }
    params.push(req.tenant.timezone ?? 'Asia/Kolkata');
    const tzIdx = params.length;
    const where = `WHERE ${conds.join(' AND ')}`;
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT to_char((f.next_action_datetime AT TIME ZONE $${tzIdx})::date, 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE f.status = 'planned')::int   AS planned,
              count(*) FILTER (WHERE f.status = 'done')::int      AS done,
              count(*) FILTER (WHERE f.status = 'missed')::int    AS missed,
              count(*) FILTER (WHERE f.status = 'cancelled')::int AS cancelled,
              count(*)::int AS total
         FROM lead_followups f
         JOIN leads l ON l.id = f.lead_id
         ${where}
         GROUP BY 1
         ORDER BY 1`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Range analytics: status totals + per-lead breakdown for date_from..date_to.
// Same scope rules as /follow-ups and /calendar.
router.get('/analytics', async (req, res, next) => {
  try {
    const date_from = req.query.date_from;
    const date_to   = req.query.date_to;
    const conds = ['f.deleted_at IS NULL'];
    const params = [];
    if (date_from) { params.push(date_from); conds.push(`f.next_action_datetime >= $${params.length}::timestamptz`); }
    if (date_to)   { params.push(date_to);   conds.push(`f.next_action_datetime <= $${params.length}::timestamptz`); }
    if (req.query.assigned_user_id) { params.push(req.query.assigned_user_id); conds.push(`l.assigned_to = $${params.length}`); }
    if (req.query.stage_id)         { params.push(req.query.stage_id);         conds.push(`l.stage_id = $${params.length}`); }
    if (req.user.role === SYSTEM_TENANT_ROLES.COUNSELLOR) {
      params.push(req.user.id);
      conds.push(`(f.created_by = $${params.length} OR l.assigned_to = $${params.length})`);
    } else if (req.user.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
      const team = await teamHierarchy(req.tenant, req.user.id);
      params.push(team);
      params.push(req.user.id);
      conds.push(`(l.assigned_to = ANY($${params.length - 1}::uuid[]) OR f.created_by = $${params.length})`);
    }
    const where = `WHERE ${conds.join(' AND ')}`;

    const [totalsRes, byLeadRes] = await Promise.all([
      tenantQuery(
        req.tenant,
        `SELECT count(*) FILTER (WHERE f.status = 'planned')::int   AS planned,
                count(*) FILTER (WHERE f.status = 'done')::int      AS done,
                count(*) FILTER (WHERE f.status = 'missed')::int    AS missed,
                count(*) FILTER (WHERE f.status = 'cancelled')::int AS cancelled,
                count(*)::int AS total
           FROM lead_followups f
           JOIN leads l ON l.id = f.lead_id
           ${where}`,
        params,
      ),
      tenantQuery(
        req.tenant,
        `SELECT l.id   AS lead_id,
                l.name AS lead_name,
                l.phone AS lead_phone,
                au.name AS lead_assigned_to_name,
                s.name  AS lead_stage_name,
                count(*) FILTER (WHERE f.status = 'planned')::int   AS planned,
                count(*) FILTER (WHERE f.status = 'done')::int      AS done,
                count(*) FILTER (WHERE f.status = 'missed')::int    AS missed,
                count(*) FILTER (WHERE f.status = 'cancelled')::int AS cancelled,
                count(*)::int AS total
           FROM lead_followups f
           JOIN leads l            ON l.id  = f.lead_id
           LEFT JOIN users         au ON au.id = l.assigned_to
           LEFT JOIN lead_stages    s ON s.id  = l.stage_id
           ${where}
           GROUP BY l.id, l.name, l.phone, au.name, s.name
           ORDER BY total DESC, l.name ASC
           LIMIT 500`,
        params,
      ),
    ]);
    res.json({
      data: {
        totals: totalsRes.rows[0] || { planned: 0, done: 0, missed: 0, cancelled: 0, total: 0 },
        by_lead: byLeadRes.rows,
      },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

router.get('/my', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT f.*, l.name AS lead_name, l.phone AS lead_phone
         FROM lead_followups f
         JOIN leads l ON l.id = f.lead_id
        WHERE f.deleted_at IS NULL AND f.status = 'planned'
          AND (f.created_by = $1 OR l.assigned_to = $1)
        ORDER BY f.next_action_datetime ASC LIMIT 200`,
      [req.user.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/overdue', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT f.*, l.name AS lead_name
         FROM lead_followups f JOIN leads l ON l.id = f.lead_id
        WHERE f.deleted_at IS NULL AND f.status = 'planned' AND f.next_action_datetime < now()
          AND (f.created_by = $1 OR l.assigned_to = $1)
        ORDER BY f.next_action_datetime ASC`,
      [req.user.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', validate({ body: createSchema }), async (req, res, next) => {
  try {
    if (req.body.recurrence_rule && !isValidRRule(req.body.recurrence_rule)) {
      throw validationError([{ path: 'recurrence_rule', message: 'invalid RRULE string' }]);
    }
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO lead_followups (lead_id, next_action_datetime, comment, stage_id, sub_stage_id, created_by, recurrence_rule, recurrence_end, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'planned') RETURNING *`,
      [req.body.lead_id, req.body.next_action_datetime, req.body.comment ?? null, req.body.stage_id ?? null, req.body.sub_stage_id ?? null, req.user.id, req.body.recurrence_rule ?? null, req.body.recurrence_end ?? null],
    );
    await tenantQuery(
      req.tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1,$2,'follow_up_scheduled',$3,$4::jsonb)`,
      [req.body.lead_id, req.user.id, 'Follow-up scheduled', JSON.stringify({ at: req.body.next_action_datetime })],
    );
    await publish(QUEUE_NAMES.EVENTS, EVENT_TYPES.FOLLOWUP_SCHEDULED, {
      type: EVENT_TYPES.FOLLOWUP_SCHEDULED,
      tenantId: req.tenant.id,
      occurredAt: new Date().toISOString(),
      actorUserId: req.user.id,
      entityType: 'follow_up',
      entityId: rows[0].id,
      payload: { lead_id: req.body.lead_id, next_action_datetime: req.body.next_action_datetime },
    });
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put(
  '/:id',
  validate({ params: idParam, body: updateSchema }),
  optimisticLock(async (req) => {
    const { rows } = await tenantQuery(req.tenant, `SELECT updated_at FROM lead_followups WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    return rows[0]?.updated_at ?? null;
  }),
  async (req, res, next) => {
    try {
      if (req.body.recurrence_rule && !isValidRRule(req.body.recurrence_rule)) {
        throw validationError([{ path: 'recurrence_rule', message: 'invalid RRULE' }]);
      }
      const { rows: existing } = await tenantQuery(req.tenant, `SELECT created_by FROM lead_followups WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
      if (!existing[0]) throw notFound('Follow-up not found');
      if (existing[0].created_by !== req.user.id && req.user.role === SYSTEM_TENANT_ROLES.COUNSELLOR) throw forbidden('Not your follow-up');
      const fields = []; const params = []; let i = 1;
      for (const [k, v] of Object.entries(req.body)) {
        if (v === undefined) continue;
        fields.push(`${k} = $${i}`); params.push(v); i += 1;
      }
      params.push(req.params.id);
      const { rows } = await tenantQuery(req.tenant, `UPDATE lead_followups SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params);
      res.json({ data: rows[0], meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

router.post('/:id/complete', validate({ params: idParam }), async (req, res, next) => {
  try {
    const result = await tenantTx(req.tenant, async (client) => {
      const { rows } = await client.query(
        `UPDATE lead_followups
            SET status = 'done', completed_at = now(), completed_by = $2
          WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        [req.params.id, req.user.id],
      );
      if (!rows[0]) throw notFound('Follow-up not found');
      await client.query(
        `INSERT INTO lead_activities (lead_id, user_id, type, summary) VALUES ($1,$2,'follow_up_completed',$3)`,
        [rows[0].lead_id, req.user.id, 'Follow-up completed'],
      );
      return rows[0];
    });
    await publish(QUEUE_NAMES.EVENTS, EVENT_TYPES.FOLLOWUP_COMPLETED, {
      type: EVENT_TYPES.FOLLOWUP_COMPLETED,
      tenantId: req.tenant.id,
      occurredAt: new Date().toISOString(),
      actorUserId: req.user.id,
      entityType: 'follow_up',
      entityId: result.id,
      payload: { lead_id: result.lead_id },
    });
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/reschedule', validate({ params: idParam, body: z.object({ next_action_datetime: z.coerce.date() }) }), async (req, res, next) => {
  try {
    // Reset BOTH reminder flags + overdue flag so the new due time gets
    // a fresh T-15 + T-5 + overdue cycle. Status flips back to planned
    // even if the row was 'missed' — the counsellor is taking action again.
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE lead_followups
          SET next_action_datetime = $2,
              status = 'planned',
              reminder_sent_at = NULL,
              reminder_5min_sent_at = NULL,
              overdue_notified_at = NULL,
              completed_at = NULL,
              completed_by = NULL
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [req.params.id, req.body.next_action_datetime],
    );
    if (!rows[0]) throw notFound('Follow-up not found');
    // Audit row so the timeline shows the reschedule.
    await tenantQuery(
      req.tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, $2, 'follow_up_rescheduled', 'Follow-up rescheduled', $3::jsonb)`,
      [rows[0].lead_id, req.user.id, JSON.stringify({ follow_up_id: rows[0].id, new_due: req.body.next_action_datetime })],
    );
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Explicit cancel — open to all 3 tenant roles. We DON'T soft-delete
// (DELETE /:id below still does that); cancelling sets status='cancelled'
// but leaves the row visible so the timeline / reports still show that
// a follow-up was scheduled-then-cancelled.
router.post('/:id/cancel', validate({ params: idParam, body: z.object({ reason: z.string().max(500).optional() }).optional() }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE lead_followups
          SET status = 'cancelled', completed_at = now(), completed_by = $2
        WHERE id = $1 AND deleted_at IS NULL AND status IN ('planned', 'missed')
        RETURNING *`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw notFound('Follow-up not found or already finalised');
    await tenantQuery(
      req.tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, $2, 'follow_up_cancelled', 'Follow-up cancelled', $3::jsonb)`,
      [rows[0].lead_id, req.user.id, JSON.stringify({ follow_up_id: rows[0].id, reason: req.body?.reason ?? null })],
    );
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `UPDATE lead_followups SET deleted_at = now(), status = 'cancelled' WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
