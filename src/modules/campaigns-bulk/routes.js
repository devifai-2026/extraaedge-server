import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES, QUEUE_NAMES, EVENT_TYPES } from '../../config/constants.js';
import { notFound, forbidden } from '../../lib/errors.js';
import { publish } from '../../lib/queue.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  channel: z.enum(['email', 'sms', 'whatsapp', 'multi']),
  audience_filter_json: z.record(z.string(), z.any()).default({}),
  email_template_id: z.string().uuid().optional(),
  sms_template_id: z.string().uuid().optional(),
  whatsapp_template_id: z.string().uuid().optional(),
  respects_business_hours: z.boolean().default(true),
  scheduled_at: z.coerce.date().optional(),
});
const updateSchema = createSchema.partial();
const listQuery = z.object({
  stage: z.enum(['DRAFT', 'IN_PROGRESS', 'COMPLETED', 'STOPPED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const idParam = z.object({ id: z.string().uuid() });

const COLS = 'id, name, description, stage, channel, audience_filter_json, email_template_id, sms_template_id, whatsapp_template_id, respects_business_hours, scheduled_at, started_at, completed_at, created_by, created_at, updated_at';

router.get('/', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = ['deleted_at IS NULL'];
    const params = [];
    if (req.query.stage) { params.push(req.query.stage); conds.push(`stage = $${params.length}`); }
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT c.${COLS.split(',').map(x => x.trim()).join(', c.')}, s.leads_count, s.email_delivered, s.sms_delivered, s.wa_delivered
         FROM campaigns_bulk c LEFT JOIN campaigns_bulk_stats s ON s.campaign_id = c.id
        WHERE ${conds.join(' AND ')} ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows: [c] } = await tenantQuery(req.tenant, `SELECT ${COLS} FROM campaigns_bulk WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!c) throw notFound('Campaign not found');
    res.json({ data: c, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: createSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO campaigns_bulk (name, description, channel, audience_filter_json, email_template_id, sms_template_id, whatsapp_template_id, respects_business_hours, scheduled_at, stage, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,'DRAFT',$10) RETURNING ${COLS}`,
      [req.body.name, req.body.description ?? null, req.body.channel, JSON.stringify(req.body.audience_filter_json), req.body.email_template_id ?? null, req.body.sms_template_id ?? null, req.body.whatsapp_template_id ?? null, req.body.respects_business_hours, req.body.scheduled_at ?? null, req.user.id],
    );
    await tenantQuery(req.tenant, `INSERT INTO campaigns_bulk_stats (campaign_id) VALUES ($1) ON CONFLICT DO NOTHING`, [rows[0].id]);
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: updateSchema }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      const val = k === 'audience_filter_json' ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE campaigns_bulk SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL AND stage = 'DRAFT' RETURNING ${COLS}`, params);
    if (!rows[0]) throw forbidden('Only DRAFT campaigns can be edited');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `UPDATE campaigns_bulk SET deleted_at = now(), stage = 'STOPPED' WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.post('/:id/clone', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO campaigns_bulk (name, description, channel, audience_filter_json, email_template_id, sms_template_id, whatsapp_template_id, respects_business_hours, stage, created_by)
       SELECT name || ' (copy)', description, channel, audience_filter_json, email_template_id, sms_template_id, whatsapp_template_id, respects_business_hours, 'DRAFT', $2
         FROM campaigns_bulk WHERE id = $1 AND deleted_at IS NULL RETURNING ${COLS}`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw notFound('Campaign not found');
    await tenantQuery(req.tenant, `INSERT INTO campaigns_bulk_stats (campaign_id) VALUES ($1)`, [rows[0].id]);
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/launch', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE campaigns_bulk SET stage = 'IN_PROGRESS', started_at = now() WHERE id = $1 AND deleted_at IS NULL AND stage = 'DRAFT' RETURNING ${COLS}`,
      [req.params.id],
    );
    if (!rows[0]) throw forbidden('Campaign cannot be launched in its current state');
    await publish(QUEUE_NAMES.CAMPAIGN, 'run', { tenantId: req.tenant.id, campaign_id: req.params.id });
    await publish(QUEUE_NAMES.EVENTS, EVENT_TYPES.CAMPAIGN_LAUNCHED, {
      type: EVENT_TYPES.CAMPAIGN_LAUNCHED, tenantId: req.tenant.id, occurredAt: new Date().toISOString(),
      entityType: 'campaign', entityId: req.params.id,
    });
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/stop', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE campaigns_bulk SET stage = 'STOPPED', completed_at = now() WHERE id = $1 AND deleted_at IS NULL AND stage = 'IN_PROGRESS' RETURNING ${COLS}`,
      [req.params.id],
    );
    if (!rows[0]) throw forbidden('Campaign is not in progress');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id/stats', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM campaigns_bulk_stats WHERE campaign_id = $1`, [req.params.id]);
    res.json({ data: rows[0] ?? null, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id/recipients', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT m.id, m.lead_id, m.channel, m.status, m.recipient, m.sent_at, m.delivered_at, m.failed_at, m.error
         FROM message_log m WHERE m.campaign_id = $1 ORDER BY m.sent_at DESC LIMIT 1000`,
      [req.params.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/preview', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    // Count how many leads currently match the filter — stubs complex filter JSON → single count query.
    const { rows: [c] } = await tenantQuery(req.tenant, `SELECT audience_filter_json FROM campaigns_bulk WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!c) throw notFound('Campaign not found');
    const filter = c.audience_filter_json ?? {};
    const conds = ['deleted_at IS NULL'];
    const params = [];
    if (filter.stage_ids) { params.push(filter.stage_ids); conds.push(`stage_id = ANY($${params.length}::uuid[])`); }
    if (filter.program_ids) { params.push(filter.program_ids); conds.push(`program_id = ANY($${params.length}::uuid[])`); }
    if (filter.assigned_to) { params.push(filter.assigned_to); conds.push(`assigned_to = ANY($${params.length}::uuid[])`); }
    const { rows } = await tenantQuery(req.tenant, `SELECT count(*)::int AS n FROM leads WHERE ${conds.join(' AND ')}`, params);
    res.json({ data: { audience_count: rows[0].n }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
