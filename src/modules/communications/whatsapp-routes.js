import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired, tenantOptional } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { publish } from '../../lib/queue.js';
import { QUEUE_NAMES, SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notFound, forbidden, noOptin, suppressed } from '../../lib/errors.js';
import { verifyWebhookSignature, normalizeStatus, normalizeInbound } from '../../lib/providers/whatsapp-wabridge.js';

const router = express.Router();

// Webhook — inbound + status
router.post('/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  tenantOptional,
  async (req, res, next) => {
    try {
      const rawBody = req.body.toString('utf8');
      const sig = req.headers['x-wabridge-signature'] || '';
      if (!verifyWebhookSignature({ rawBody, receivedSignature: sig })) {
        return res.status(401).json({ error: { code: 'INVALID_SIGNATURE' } });
      }
      if (!req.tenant) return res.status(400).json({ error: { code: 'TENANT_REQUIRED' } });
      const event = JSON.parse(rawBody);

      if (event.statuses) {
        for (const s of event.statuses) {
          const n = normalizeStatus(s);
          await tenantQuery(
            req.tenant,
            `UPDATE message_log
                SET status = $2,
                    delivered_at = CASE WHEN $2='delivered' THEN $3::timestamptz ELSE delivered_at END,
                    seen_at = CASE WHEN $2='seen' THEN $3::timestamptz ELSE seen_at END,
                    failed_at = CASE WHEN $2='failed' THEN $3::timestamptz ELSE failed_at END
              WHERE provider_message_id = $1`,
            [n.provider_message_id, n.status, n.occurred_at],
          );
        }
      }
      if (event.messages) {
        for (const m of event.messages) {
          const n = normalizeInbound(m);
          // Try to match to a lead by phone number
          const { rows: matched } = await tenantQuery(
            req.tenant,
            `SELECT id, assigned_to FROM leads WHERE deleted_at IS NULL AND (whatsapp_number = $1 OR phone = $1) LIMIT 1`,
            [n.from],
          );
          const lead_id = matched[0]?.id ?? null;
          await tenantQuery(
            req.tenant,
            `INSERT INTO message_reply (lead_id, channel, provider_message_id, body, received_at, routed_to_user_id)
             VALUES ($1,'whatsapp',$2,$3,$4,$5)`,
            [lead_id, m.id, n.body, n.occurred_at, matched[0]?.assigned_to ?? null],
          );
        }
      }
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

router.use(authRequired, tenantRequired);

const TPL_COLS = 'id, wabridge_template_name, language, category, body, footer, header_type, buttons_json, variables, status, is_visible, created_by, created_at, updated_at';
const tplSchema = z.object({
  wabridge_template_name: z.string().min(1),
  language: z.string().default('en'),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).default('UTILITY'),
  body: z.string().optional(),
  footer: z.string().optional(),
  header_type: z.string().optional(),
  buttons_json: z.array(z.any()).optional(),
  variables: z.array(z.string()).optional(),
  is_visible: z.boolean().default(true),
});
const idParam = z.object({ id: z.string().uuid() });

router.get('/templates', async (req, res, next) => {
  try { const { rows } = await tenantQuery(req.tenant, `SELECT ${TPL_COLS} FROM whatsapp_templates WHERE deleted_at IS NULL ORDER BY wabridge_template_name`); res.json({ data: rows, meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.post('/templates', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: tplSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO whatsapp_templates (wabridge_template_name, language, category, body, footer, header_type, buttons_json, variables, is_visible, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${TPL_COLS}`,
      [req.body.wabridge_template_name, req.body.language, req.body.category, req.body.body ?? null, req.body.footer ?? null, req.body.header_type ?? null, req.body.buttons_json ? JSON.stringify(req.body.buttons_json) : null, req.body.variables ?? null, req.body.is_visible, req.user.id],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/templates/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: tplSchema.partial() }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      const val = k === 'buttons_json' ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE whatsapp_templates SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${TPL_COLS}`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/templates/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE whatsapp_templates SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

// Send
const sendSchema = z.object({
  lead_id: z.string().uuid(),
  template_id: z.string().uuid(),
  send_to: z.enum(['lead', 'father', 'mother', 'guardian']).default('lead'),
  variable_overrides: z.record(z.string(), z.any()).optional(),
});

router.post('/send', validate({ body: sendSchema }), async (req, res, next) => {
  try {
    const { rows: [lead] } = await tenantQuery(req.tenant, `SELECT l.*, f.father_mobile, f.mother_mobile, f.guardian_mobile FROM leads l LEFT JOIN lead_family f ON f.lead_id = l.id WHERE l.id = $1 AND l.deleted_at IS NULL`, [req.body.lead_id]);
    if (!lead) throw notFound('Lead not found');
    const recipientMap = { lead: lead.whatsapp_number ?? lead.phone, father: lead.father_mobile, mother: lead.mother_mobile, guardian: lead.guardian_mobile };
    const recipient = recipientMap[req.body.send_to];
    if (!recipient) throw forbidden(`Lead has no WhatsApp number for '${req.body.send_to}'`);

    const { rows: [tpl] } = await tenantQuery(req.tenant, `SELECT * FROM whatsapp_templates WHERE id = $1 AND deleted_at IS NULL`, [req.body.template_id]);
    if (!tpl) throw notFound('Template not found');
    if (tpl.status !== 'APPROVED') throw forbidden('Template not approved by WhatsApp yet');

    // Marketing templates require opt-in record
    if (tpl.category === 'MARKETING') {
      const { rows: optin } = await tenantQuery(req.tenant, `SELECT 1 FROM optin_log WHERE lead_id = $1 AND channel = 'whatsapp' AND opted_out_at IS NULL LIMIT 1`, [lead.id]);
      if (!optin[0]) throw noOptin('whatsapp', lead.id);
    }

    const { rows: supp } = await tenantQuery(req.tenant, `SELECT 1 FROM suppression_list WHERE channel='whatsapp' AND address = $1 LIMIT 1`, [recipient]);
    if (supp[0]) throw suppressed('whatsapp', recipient);

    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO message_log (lead_id, user_id, channel, template_id, language, recipient, provider, status)
       VALUES ($1,$2,'whatsapp',$3,$4,$5,'wabridge','queued') RETURNING id`,
      [lead.id, req.user.id, tpl.id, tpl.language, recipient],
    );
    await publish(QUEUE_NAMES.WHATSAPP, 'send', { tenantId: req.tenant.id, message_log_id: rows[0].id, lead_id: lead.id, template_id: tpl.id, variable_overrides: req.body.variable_overrides ?? {} });
    res.status(202).json({ data: { message_log_id: rows[0].id }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Quota
router.get('/quota', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT q.*, n.phone FROM whatsapp_quota q LEFT JOIN whatsapp_numbers n ON n.id = q.whatsapp_number_id`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/usage', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT date_trunc('day', sent_at) AS day, count(*)::int AS sent, count(*) FILTER (WHERE status='delivered')::int AS delivered
         FROM message_log WHERE channel = 'whatsapp' AND sent_at > now() - interval '30 days'
        GROUP BY 1 ORDER BY 1 DESC`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Numbers + inbox
router.get('/numbers', async (req, res, next) => {
  try { const { rows } = await tenantQuery(req.tenant, `SELECT * FROM whatsapp_numbers WHERE deleted_at IS NULL ORDER BY phone`); res.json({ data: rows, meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.get('/inbox', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT r.*, l.name AS lead_name FROM message_reply r LEFT JOIN leads l ON l.id = r.lead_id
        WHERE r.channel = 'whatsapp' AND r.is_read = false
          AND (r.routed_to_user_id = $1 OR $2 IN ('super_admin','sales_manager'))
        ORDER BY r.received_at DESC LIMIT 200`,
      [req.user.id, req.user.role],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/messages/:id/assign', validate({ params: idParam, body: z.object({ user_id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `UPDATE message_reply SET routed_to_user_id = $2 WHERE id = $1`, [req.params.id, req.body.user_id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
