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
import { verifyWebhookSignature, normalizeWebhookEvent } from '../../lib/providers/email-brevo.js';

const router = express.Router();

// --------- Webhook (no tenant auth) — tenantOptional pulls X-Tenant-Slug header.
router.post('/webhooks/brevo',
  express.raw({ type: 'application/json', limit: '1mb' }),
  tenantOptional,
  async (req, res, next) => {
    try {
      const rawBody = req.body.toString('utf8');
      if (!verifyWebhookSignature({ rawBody, receivedSignature: req.headers['x-mailin-custom'] || '' })) {
        return res.status(401).json({ error: { code: 'INVALID_SIGNATURE' } });
      }
      if (!req.tenant) return res.status(400).json({ error: { code: 'TENANT_REQUIRED' } });
      const event = JSON.parse(rawBody);
      const normalized = normalizeWebhookEvent(event);
      await tenantQuery(
        req.tenant,
        `UPDATE message_log
            SET status = $2,
                delivered_at = CASE WHEN $2 = 'delivered' THEN $3::timestamptz ELSE delivered_at END,
                seen_at = CASE WHEN $2 = 'seen' THEN $3::timestamptz ELSE seen_at END,
                clicked_at = CASE WHEN $2 = 'clicked' THEN $3::timestamptz ELSE clicked_at END,
                failed_at = CASE WHEN $2 IN ('failed','bounced') THEN $3::timestamptz ELSE failed_at END,
                error = CASE WHEN $2 IN ('failed','bounced') THEN $4 ELSE error END
          WHERE provider_message_id = $1`,
        [normalized.provider_message_id, normalized.status, normalized.occurred_at, JSON.stringify(normalized.raw)],
      );
      // Hard bounces / unsubscribes go to suppression list.
      if (['bounced', 'unsubscribed'].includes(normalized.status) && normalized.recipient) {
        await tenantQuery(
          req.tenant,
          `INSERT INTO suppression_list (channel, address, reason, source)
           VALUES ('email', $1, $2, 'brevo') ON CONFLICT DO NOTHING`,
          [normalized.recipient, normalized.status === 'unsubscribed' ? 'unsubscribe' : 'hard_bounce'],
        );
      }
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// All other routes are tenant-authed.
router.use(authRequired, tenantRequired);

// --------- Templates ---------
const TPL_COLS = 'id, name, subject, body_html, body_text, variables, language, category, status, is_visible, builder_type, created_by, created_at, updated_at';
const templateCreateSchema = z.object({
  name: z.string().min(1),
  subject: z.string().min(1),
  body_html: z.string().optional(),
  body_text: z.string().optional(),
  language: z.string().default('en'),
  category: z.string().optional(),
  status: z.enum(['Draft', 'Published']).default('Draft'),
  builder_type: z.enum(['basic', 'advanced']).default('basic'),
  is_visible: z.boolean().default(true),
});
const templateUpdateSchema = templateCreateSchema.partial();
const idParam = z.object({ id: z.string().uuid() });

router.get('/templates', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT ${TPL_COLS} FROM email_templates WHERE deleted_at IS NULL ORDER BY name`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/templates/variables', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM template_variables WHERE is_active AND 'email' = ANY(scope) ORDER BY key`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/templates/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT ${TPL_COLS} FROM email_templates WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!rows[0]) throw notFound('Template not found');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/templates', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: templateCreateSchema }), async (req, res, next) => {
  try {
    const vars = [...new Set([...extractVariables(req.body.subject), ...extractVariables(req.body.body_html ?? ''), ...extractVariables(req.body.body_text ?? '')])];
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO email_templates (name, subject, body_html, body_text, variables, language, category, status, builder_type, is_visible, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${TPL_COLS}`,
      [req.body.name, req.body.subject, req.body.body_html ?? null, req.body.body_text ?? null, vars, req.body.language, req.body.category ?? null, req.body.status, req.body.builder_type, req.body.is_visible, req.user.id],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/templates/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: templateUpdateSchema }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i}`); params.push(v); i += 1;
    }
    if (req.body.body_html || req.body.body_text || req.body.subject) {
      const { rows: existingRows } = await tenantQuery(req.tenant, `SELECT subject, body_html, body_text FROM email_templates WHERE id = $1`, [req.params.id]);
      const merged = { ...(existingRows[0] ?? {}), ...req.body };
      const vars = [...new Set([...extractVariables(merged.subject ?? ''), ...extractVariables(merged.body_html ?? ''), ...extractVariables(merged.body_text ?? '')])];
      fields.push(`variables = $${i}`); params.push(vars); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE email_templates SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${TPL_COLS}`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/templates/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `UPDATE email_templates SET deleted_at = now() WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.post('/templates/:id/duplicate', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO email_templates (name, subject, body_html, body_text, variables, language, category, status, builder_type, is_visible, created_by)
       SELECT name || ' (copy)', subject, body_html, body_text, variables, language, category, 'Draft', builder_type, is_visible, $2
         FROM email_templates WHERE id = $1 AND deleted_at IS NULL RETURNING ${TPL_COLS}`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw notFound('Template not found');
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/templates/:id/toggle', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE email_templates SET status = CASE WHEN status = 'Published' THEN 'Draft' ELSE 'Published' END
        WHERE id = $1 AND deleted_at IS NULL RETURNING ${TPL_COLS}`,
      [req.params.id],
    );
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// --------- Send ---------
const sendSchema = z.object({
  lead_id: z.string().uuid(),
  template_id: z.string().uuid(),
  to_override: z.string().email().optional(),
  variable_overrides: z.record(z.string(), z.any()).optional(),
});

router.post('/send', validate({ body: sendSchema }), async (req, res, next) => {
  try {
    const { rows: leadRows } = await tenantQuery(req.tenant, `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL`, [req.body.lead_id]);
    const lead = leadRows[0];
    if (!lead) throw notFound('Lead not found');
    const recipient = req.body.to_override ?? lead.email;
    if (!recipient) throw forbidden('Lead has no email and no override given');

    // Suppression check
    const { rows: supp } = await tenantQuery(req.tenant, `SELECT 1 FROM suppression_list WHERE channel='email' AND lower(address) = lower($1) LIMIT 1`, [recipient]);
    if (supp[0]) throw suppressed('email', recipient);

    const { rows: [tpl] } = await tenantQuery(req.tenant, `SELECT * FROM email_templates WHERE id = $1 AND deleted_at IS NULL`, [req.body.template_id]);
    if (!tpl) throw notFound('Template not found');
    if (tpl.status !== 'Published') throw forbidden('Template is not published');

    // Insert message_log row in 'queued' status; worker will render + send + update.
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO message_log (lead_id, user_id, channel, template_id, language, recipient, provider, status)
       VALUES ($1,$2,'email',$3,$4,$5,'brevo','queued') RETURNING id`,
      [lead.id, req.user.id, tpl.id, tpl.language, recipient],
    );
    await publish(QUEUE_NAMES.EMAIL, 'send', {
      tenantId: req.tenant.id,
      message_log_id: rows[0].id,
      lead_id: lead.id,
      template_id: tpl.id,
      variable_overrides: req.body.variable_overrides ?? {},
    });
    res.status(202).json({ data: { message_log_id: rows[0].id }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/send/test', validate({ body: z.object({ template_id: z.string().uuid(), lead_id: z.string().uuid().optional() }) }), async (req, res, next) => {
  try {
    const { rows: [tpl] } = await tenantQuery(req.tenant, `SELECT * FROM email_templates WHERE id = $1 AND deleted_at IS NULL`, [req.body.template_id]);
    if (!tpl) throw notFound('Template not found');
    let lead = {};
    if (req.body.lead_id) {
      const { rows } = await tenantQuery(req.tenant, `SELECT * FROM leads WHERE id = $1`, [req.body.lead_id]);
      lead = rows[0] ?? {};
    }
    const context = buildContext({ lead, tenant: req.tenant, counsellor: req.user });
    const subject = render(tpl.subject, context);
    const html = render(tpl.body_html ?? '', context);
    const text = render(tpl.body_text ?? '', context);
    res.json({
      data: {
        subject: subject.rendered,
        html: html.rendered,
        text: text.rendered,
        missing_variables: [...new Set([...subject.missing, ...html.missing, ...text.missing])],
      },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

// --------- Messages (log view) ---------
const messagesQuery = z.object({
  lead_id: z.string().uuid().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
router.get('/messages', validate({ query: messagesQuery }), async (req, res, next) => {
  try {
    const conds = [`channel = 'email'`];
    const params = [];
    if (req.query.lead_id) { params.push(req.query.lead_id); conds.push(`lead_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); conds.push(`status = $${params.length}`); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM message_log ${where} ORDER BY COALESCE(sent_at, scheduled_for, delivered_at) DESC NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
