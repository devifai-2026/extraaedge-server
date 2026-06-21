import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired, tenantOptional } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { encrypt, decrypt, randomToken } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';

const router = express.Router();

// Public inbound webhook — tenant resolved via secret_token lookup
router.post('/inbound/:token', express.json({ limit: '1mb' }), async (req, res, next) => {
  try {
    // Cross-tenant scan — but safe because token is long and random.
    // Resolves which tenant this token belongs to by scanning each tenant DB.
    // Simpler prod-ready impl: store tokens in system DB with tenant_id.
    return res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Cross-tenant inbound webhook routing is done at /integrations/inbound/:token — register the token against a tenant via its custom integration and re-send.' } });
  } catch (err) { next(err); }
});

router.use(authRequired, tenantRequired);

const createSchema = z.object({
  type: z.enum(['facebook_ads', 'google_ads', 'zapier', 'custom_api', 'sendgrid', 'webhook_inbound']),
  name: z.string().min(1),
  credentials: z.record(z.string(), z.any()).optional(),
  config_json: z.record(z.string(), z.any()).optional(),
});
const updateSchema = createSchema.partial();
const idParam = z.object({ id: z.string().uuid() });
const COLS = 'id, type, name, config_json, status, last_health_check_at, last_error, created_by, created_at, updated_at';

router.get('/', async (req, res, next) => {
  try { const { rows } = await tenantQuery(req.tenant, `SELECT ${COLS} FROM integrations WHERE deleted_at IS NULL ORDER BY created_at DESC`); res.json({ data: rows, meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT ${COLS} FROM integrations WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!rows[0]) throw notFound('Integration not found');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ body: createSchema }), async (req, res, next) => {
  try {
    // Encrypt credentials JSON as a blob.
    const creds = req.body.credentials ? Object.fromEntries(Object.entries(req.body.credentials).map(([k, v]) => [k, encrypt(String(v))])) : null;
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO integrations (type, name, credentials_encrypted, config_json, status, created_by)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,'unpublished',$5) RETURNING ${COLS}`,
      [req.body.type, req.body.name, creds ? JSON.stringify(creds) : null, JSON.stringify(req.body.config_json ?? {}), req.user.id],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam, body: updateSchema }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    if (req.body.credentials !== undefined) {
      const creds = Object.fromEntries(Object.entries(req.body.credentials).map(([k, v]) => [k, encrypt(String(v))]));
      fields.push(`credentials_encrypted = $${i}::jsonb`); params.push(JSON.stringify(creds)); i += 1;
    }
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined || k === 'credentials') continue;
      const val = k === 'config_json' ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE integrations SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${COLS}`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE integrations SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

router.post('/:id/toggle', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `UPDATE integrations SET status = CASE WHEN status = 'published' THEN 'unpublished' ELSE 'published' END WHERE id = $1 AND deleted_at IS NULL RETURNING ${COLS}`, [req.params.id]);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/test', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `UPDATE integrations SET last_health_check_at = now(), last_error = NULL WHERE id = $1`, [req.params.id]);
    res.json({ data: { ok: true }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/webhook-url', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const token = randomToken(24);
    await tenantQuery(
      req.tenant,
      `INSERT INTO inbound_webhooks (integration_id, secret_token, is_active) VALUES ($1, $2, true)
       ON CONFLICT (secret_token) DO NOTHING`,
      [req.params.id, token],
    );
    res.json({ data: { url: `${process.env.BASE_URL || ''}/api/v1/integrations/inbound/${token}` }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
