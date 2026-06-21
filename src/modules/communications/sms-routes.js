import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired, tenantOptional } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { publish } from '../../lib/queue.js';
import { QUEUE_NAMES, SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notFound, forbidden, suppressed } from '../../lib/errors.js';
import { render, extractVariables, buildContext } from '../../lib/templating.js';
import { normalizeDlrEvent } from '../../lib/providers/sms-messagecentral.js';

const router = express.Router();

// Webhook (delivery receipts + STOP keyword)
router.post('/webhooks/messagecentral',
  express.json({ limit: '1mb' }),
  tenantOptional,
  async (req, res, next) => {
    try {
      if (!req.tenant) return res.status(400).json({ error: { code: 'TENANT_REQUIRED' } });
      const ev = normalizeDlrEvent(req.body);
      await tenantQuery(
        req.tenant,
        `UPDATE message_log SET status = $2, delivered_at = CASE WHEN $2 = 'delivered' THEN $3::timestamptz ELSE delivered_at END, failed_at = CASE WHEN $2 = 'failed' THEN $3::timestamptz ELSE failed_at END WHERE provider_message_id = $1`,
        [ev.provider_message_id, ev.status, ev.occurred_at],
      );
      // STOP keyword handling — normalize inbound
      if (typeof req.body.text === 'string' && /^\s*(stop|unsub|unsubscribe)\b/i.test(req.body.text) && req.body.mobileNumber) {
        await tenantQuery(
          req.tenant,
          `INSERT INTO suppression_list (channel, address, reason, source) VALUES ('sms', $1, 'stop_keyword', 'messagecentral') ON CONFLICT DO NOTHING`,
          [req.body.mobileNumber],
        );
      }
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

router.use(authRequired, tenantRequired);

const TPL_COLS = 'id, name, body, dlt_template_id, dlt_entity_id, variables, language, is_visible, created_by, created_at, updated_at';
const tplSchema = z.object({
  name: z.string().min(1),
  body: z.string().min(1),
  dlt_template_id: z.string().optional(),
  dlt_entity_id: z.string().optional(),
  language: z.string().default('en'),
  is_visible: z.boolean().default(true),
});
const idParam = z.object({ id: z.string().uuid() });

router.get('/templates', async (req, res, next) => {
  try { const { rows } = await tenantQuery(req.tenant, `SELECT ${TPL_COLS} FROM sms_templates WHERE deleted_at IS NULL ORDER BY name`); res.json({ data: rows, meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.post('/templates', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: tplSchema }), async (req, res, next) => {
  try {
    const vars = extractVariables(req.body.body);
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO sms_templates (name, body, dlt_template_id, dlt_entity_id, variables, language, is_visible, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${TPL_COLS}`,
      [req.body.name, req.body.body, req.body.dlt_template_id ?? null, req.body.dlt_entity_id ?? null, vars, req.body.language, req.body.is_visible, req.user.id],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/templates/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: tplSchema.partial() }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i}`); params.push(v); i += 1;
    }
    if (req.body.body) { fields.push(`variables = $${i}`); params.push(extractVariables(req.body.body)); i += 1; }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE sms_templates SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${TPL_COLS}`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/templates/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE sms_templates SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

router.post('/templates/:id/toggle', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `UPDATE sms_templates SET is_visible = NOT is_visible WHERE id = $1 AND deleted_at IS NULL RETURNING ${TPL_COLS}`, [req.params.id]);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

const sendSchema = z.object({
  lead_id: z.string().uuid(),
  template_id: z.string().uuid(),
  to_override: z.string().optional(),
  variable_overrides: z.record(z.string(), z.any()).optional(),
});

router.post('/send', validate({ body: sendSchema }), async (req, res, next) => {
  try {
    const { rows: [lead] } = await tenantQuery(req.tenant, `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL`, [req.body.lead_id]);
    if (!lead) throw notFound('Lead not found');
    const recipient = req.body.to_override ?? lead.phone ?? lead.whatsapp_number;
    if (!recipient) throw forbidden('Lead has no phone and no override given');
    const { rows: supp } = await tenantQuery(req.tenant, `SELECT 1 FROM suppression_list WHERE channel='sms' AND address = $1 LIMIT 1`, [recipient]);
    if (supp[0]) throw suppressed('sms', recipient);
    const { rows: [tpl] } = await tenantQuery(req.tenant, `SELECT * FROM sms_templates WHERE id = $1 AND deleted_at IS NULL`, [req.body.template_id]);
    if (!tpl) throw notFound('Template not found');
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO message_log (lead_id, user_id, channel, template_id, language, recipient, provider, status)
       VALUES ($1,$2,'sms',$3,$4,$5,'messagecentral','queued') RETURNING id`,
      [lead.id, req.user.id, tpl.id, tpl.language, recipient],
    );
    await publish(QUEUE_NAMES.SMS, 'send', { tenantId: req.tenant.id, message_log_id: rows[0].id, lead_id: lead.id, template_id: tpl.id, variable_overrides: req.body.variable_overrides ?? {} });
    res.status(202).json({ data: { message_log_id: rows[0].id }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/send/test', validate({ body: z.object({ template_id: z.string().uuid(), lead_id: z.string().uuid().optional() }) }), async (req, res, next) => {
  try {
    const { rows: [tpl] } = await tenantQuery(req.tenant, `SELECT * FROM sms_templates WHERE id = $1 AND deleted_at IS NULL`, [req.body.template_id]);
    if (!tpl) throw notFound('Template not found');
    let lead = {};
    if (req.body.lead_id) {
      const { rows } = await tenantQuery(req.tenant, `SELECT * FROM leads WHERE id = $1`, [req.body.lead_id]);
      lead = rows[0] ?? {};
    }
    const context = buildContext({ lead, tenant: req.tenant, counsellor: req.user });
    const body = render(tpl.body, context);
    res.json({ data: { body: body.rendered, missing_variables: body.missing, chars: body.rendered.length }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
