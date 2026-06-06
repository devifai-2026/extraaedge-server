import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

// NOTE: WhatsApp sending has moved to the per-user whatsapp-web.js gateway
// (see whatsapp-connection-routes.js). The WABridge Business-API path —
// inbound webhook, templated /send, and /quota — has been removed. What remains
// here is the read/CRUD surface the admin UI still uses: templates, numbers,
// inbox, usage. New WhatsApp message rows carry provider='wwebjs'.
const router = express.Router();

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

// Templated send (POST /send) and the WABridge quota endpoint have been
// REMOVED. WhatsApp now sends free-text from each user's own number via
// POST /whatsapp/connection/send (see whatsapp-connection-routes.js). The quota
// model doesn't apply to whatsapp-web.js session messages.

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
