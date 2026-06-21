import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired, tenantOptional } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { clickToCall, fetchRecording, normalizeWebhook } from '../../lib/providers/telephony-exotel.js';
import { putObject, getDownloadSignedUrl, buildKey } from '../../lib/r2.js';
import { nanoid } from 'nanoid';
import { forbidden, notFound } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, EVENT_TYPES, QUEUE_NAMES } from '../../config/constants.js';
import { publish } from '../../lib/queue.js';

const router = express.Router();

// --------- Webhook (Exotel StatusCallback) ----------
router.post('/webhooks/exotel',
  express.json({ limit: '1mb' }),
  tenantOptional,
  async (req, res, next) => {
    try {
      if (!req.tenant) return res.status(400).json({ error: { code: 'TENANT_REQUIRED' } });
      const n = normalizeWebhook(req.body);
      const { rows } = await tenantQuery(
        req.tenant,
        `UPDATE calls
            SET status = $2,
                duration_seconds = $3,
                ended_at = $4,
                started_at = COALESCE(started_at, $4)
          WHERE provider_call_id = $1
          RETURNING id, lead_id`,
        [n.provider_call_id, n.status, n.duration_seconds, n.occurred_at],
      );
      // Fetch + upload recording to R2
      if (rows[0] && n.recording_url) {
        try {
          const audio = await fetchRecording(n.recording_url);
          const key = buildKey({ tenantSlug: req.tenant.slug, purpose: 'recording', id: nanoid(20), ext: 'mp3' });
          await putObject({ key, body: audio, contentType: 'audio/mpeg' });
          await tenantQuery(
            req.tenant,
            `UPDATE calls SET recording_r2_key = $2, recording_size_bytes = $3, recording_stored_at = now() WHERE id = $1`,
            [rows[0].id, key, audio.length],
          );
        } catch (err) {
          // don't fail the webhook
          await tenantQuery(req.tenant, `UPDATE calls SET remarks = COALESCE(remarks,'') || ' | recording fetch failed: ' || $2 WHERE id = $1`, [rows[0].id, String(err.message).slice(0, 200)]);
        }
      }
      if (rows[0]) {
        await publish(QUEUE_NAMES.EVENTS, EVENT_TYPES.CALL_COMPLETED, {
          type: EVENT_TYPES.CALL_COMPLETED,
          tenantId: req.tenant.id,
          occurredAt: new Date().toISOString(),
          entityType: 'call',
          entityId: rows[0].id,
          payload: { lead_id: rows[0].lead_id, status: n.status, duration_seconds: n.duration_seconds },
        });
      }
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

router.use(authRequired, tenantRequired);

const dispositionSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  category: z.enum(['positive', 'neutral', 'negative']),
  requires_callback: z.boolean().default(false),
  auto_create_followup_hours: z.coerce.number().int().positive().optional(),
  is_active: z.boolean().default(true),
  order_index: z.coerce.number().int().default(0),
});
const idParam = z.object({ id: z.string().uuid() });

// Dispositions CRUD
router.get('/dispositions', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM call_dispositions WHERE deleted_at IS NULL ORDER BY order_index, label`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/dispositions', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ body: dispositionSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO call_dispositions (code, label, category, requires_callback, auto_create_followup_hours, is_active, order_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.body.code, req.body.label, req.body.category, req.body.requires_callback, req.body.auto_create_followup_hours ?? null, req.body.is_active, req.body.order_index],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/dispositions/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam, body: dispositionSchema.partial() }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i}`); params.push(v); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE call_dispositions SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/dispositions/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE call_dispositions SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

// --------- Calls ---------
const callLogSchema = z.object({
  lead_id: z.string().uuid(),
  direction: z.enum(['outbound', 'inbound']).default('outbound'),
  status: z.enum(['scheduled', 'ringing', 'answered', 'completed', 'missed', 'no_answer', 'failed']).default('completed'),
  duration_seconds: z.coerce.number().int().nonnegative().optional(),
  remarks: z.string().optional(),
  disposition_code: z.string().optional(),
  scheduled_for: z.coerce.date().optional(),
  started_at: z.coerce.date().optional(),
  ended_at: z.coerce.date().optional(),
});
const listQuery = z.object({
  lead_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = ['c.deleted_at IS NULL'];
    const params = [];
    if (req.query.lead_id) { params.push(req.query.lead_id); conds.push(`c.lead_id = $${params.length}`); }
    if (req.query.user_id) { params.push(req.query.user_id); conds.push(`c.user_id = $${params.length}`); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT c.*, u.name AS user_name, l.name AS lead_name FROM calls c
         LEFT JOIN users u ON u.id = c.user_id LEFT JOIN leads l ON l.id = c.lead_id
         ${where} ORDER BY COALESCE(c.started_at, c.created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', validate({ body: callLogSchema }), async (req, res, next) => {
  try {
    const result = await tenantTx(req.tenant, async (client) => {
      const { rows: dispRows } = req.body.disposition_code
        ? await client.query(`SELECT category, requires_callback, auto_create_followup_hours FROM call_dispositions WHERE code = $1 AND is_active = true`, [req.body.disposition_code])
        : { rows: [] };
      const disp = dispRows[0];
      const { rows } = await client.query(
        `INSERT INTO calls (lead_id, user_id, direction, status, duration_seconds, remarks, disposition_code, disposition_category, callback_requested_at, scheduled_for, started_at, ended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [req.body.lead_id, req.user.id, req.body.direction, req.body.status, req.body.duration_seconds ?? null, req.body.remarks ?? null, req.body.disposition_code ?? null, disp?.category ?? null, disp?.requires_callback ? new Date() : null, req.body.scheduled_for ?? null, req.body.started_at ?? null, req.body.ended_at ?? null],
      );
      await client.query(
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
         VALUES ($1,$2,'call_logged',$3,$4::jsonb)`,
        [req.body.lead_id, req.user.id, `Call logged: ${req.body.status}`, JSON.stringify({ call_id: rows[0].id, disposition: req.body.disposition_code })],
      );
      // Auto-follow-up on dispositions that require it
      if (disp?.requires_callback && disp.auto_create_followup_hours) {
        const when = new Date(Date.now() + disp.auto_create_followup_hours * 3600_000);
        await client.query(
          `INSERT INTO lead_followups (lead_id, next_action_datetime, comment, created_by, status)
           VALUES ($1,$2,$3,$4,'planned')`,
          [req.body.lead_id, when, `Auto-created from disposition: ${req.body.disposition_code}`, req.user.id],
        );
      }
      return rows[0];
    });
    res.status(201).json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM calls WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!rows[0]) throw notFound('Call not found');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id/recording', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT recording_r2_key FROM calls WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!rows[0] || !rows[0].recording_r2_key) throw notFound('Recording not available');
    const url = await getDownloadSignedUrl({ key: rows[0].recording_r2_key, downloadAs: `call-${req.params.id}.mp3` });
    res.json({ data: { url }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Click-to-call — initiates bridge call via Exotel
const cleanPhone = (p) => (p || '').replace(/\s/g, '');
router.post('/click-to-call', validate({ body: z.object({ lead_id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    const { rows: [lead] } = await tenantQuery(req.tenant, `SELECT phone, whatsapp_number FROM leads WHERE id = $1 AND deleted_at IS NULL`, [req.body.lead_id]);
    if (!lead) throw notFound('Lead not found');
    const leadPhone = cleanPhone(lead.phone ?? lead.whatsapp_number);
    if (!leadPhone) throw forbidden('Lead has no phone number');
    const { rows: [counsellor] } = await tenantQuery(req.tenant, `SELECT phone FROM users WHERE id = $1`, [req.user.id]);
    if (!counsellor?.phone) throw forbidden('Your user record has no phone; add one in profile to click-to-call');

    const statusCallbackUrl = `${process.env.BASE_URL || ''}/api/v1/calls/webhooks/exotel`;
    const callInit = await clickToCall({
      counsellor_phone: cleanPhone(counsellor.phone),
      lead_phone: leadPhone,
      status_callback_url: statusCallbackUrl,
      record: true,
    });

    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO calls (lead_id, user_id, direction, status, provider, provider_call_id)
       VALUES ($1,$2,'outbound',$3,'exotel',$4) RETURNING *`,
      [req.body.lead_id, req.user.id, callInit.status ?? 'queued', callInit.provider_call_id ?? null],
    );
    res.status(202).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
