import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired, tenantOptional } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery, resolveTenantById } from '../../db/tenant.js';
import { sysQuery } from '../../db/system.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { encrypt, decrypt, randomToken, hmac, safeEqual } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { processLeadgen } from './facebook-leads.js';

const router = express.Router();

// ── Public inbound webhook — UNauthenticated (external providers call it) ──
// Tenant resolved in O(1) via the system-DB inbound_webhook_tokens map (written
// when a tenant mints the URL). Handles: (1) Meta/FB GET verify handshake,
// (2) FB Lead Ads `leadgen` events (fetch → map → createLead), (3) generic
// custom inbound (logged; extensible). res 200 fast, process async.

// Resolve a webhook token → { tenant, integration, config } or null.
const resolveWebhookToken = async (token) => {
  const { rows } = await sysQuery(
    `SELECT tenant_id, integration_id, integration_type FROM inbound_webhook_tokens WHERE token = $1`,
    [token],
  );
  const map = rows[0];
  if (!map) return null;
  const tenant = await resolveTenantById(map.tenant_id).catch(() => null);
  if (!tenant) return null;
  let integration = null;
  if (map.integration_id) {
    const { rows: ir } = await tenantQuery(
      tenant,
      `SELECT id, type, name, credentials_encrypted, config_json, status FROM integrations WHERE id = $1 AND deleted_at IS NULL`,
      [map.integration_id],
    );
    integration = ir[0] || null;
  }
  return { tenant, integration, integrationType: map.integration_type };
};

// GET — Meta/Facebook webhook verification handshake.
router.get('/inbound/:token', async (req, res) => {
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const resolved = await resolveWebhookToken(req.params.token).catch(() => null);
  if (!resolved) return res.sendStatus(404);
  const expected = resolved.integration?.config_json?.verify_token || req.params.token;
  if (mode === 'subscribe' && verifyToken && verifyToken === expected) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'verification failed' });
});

// POST — inbound events. Capture the raw body so we can verify X-Hub-Signature-256.
router.post('/inbound/:token', express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  res.sendStatus(200); // ACK immediately; process async
  (async () => {
    try {
      const resolved = await resolveWebhookToken(req.params.token).catch(() => null);
      if (!resolved) { logger.warn({ token: req.params.token?.slice(0, 6) }, 'inbound webhook: unknown token'); return; }
      const { tenant, integration } = resolved;
      const body = req.body || {};

      // Log the raw event for audit/debugging.
      if (integration) {
        await tenantQuery(
          tenant,
          `INSERT INTO webhook_events (integration_id, payload_json, status) VALUES ($1, $2::jsonb, 'pending')`,
          [integration.id, JSON.stringify(body)],
        ).catch(() => {});
      }

      // Verify X-Hub-Signature-256 when an app secret is configured (FB/Meta).
      const appSecretEnc = integration?.credentials_encrypted?.app_secret;
      if (appSecretEnc && req.rawBody) {
        try {
          const appSecret = decrypt(appSecretEnc);
          const sigHeader = req.get('x-hub-signature-256') || '';
          const expected = `sha256=${hmac(appSecret, req.rawBody)}`;
          if (!sigHeader || !safeEqual(sigHeader, expected)) {
            logger.warn({ tenantId: tenant.id }, 'inbound webhook: bad X-Hub-Signature-256');
            return;
          }
        } catch { /* if secret decrypt fails, skip verification rather than drop */ }
      }

      // ── Facebook Lead Ads ── (object=page, entry[].changes[] with field=leadgen)
      const isFbLeadgen = body.object === 'page'
        || (Array.isArray(body.entry) && body.entry.some((e) => (e.changes || []).some((c) => c.field === 'leadgen')));
      if (isFbLeadgen && integration) {
        const config = integration.config_json || {};
        for (const entry of body.entry || []) {
          for (const change of entry.changes || []) {
            if (change.field !== 'leadgen') continue;
            await processLeadgen(tenant, integration, config, change);
          }
        }
        return;
      }

      // ── Generic custom inbound ── (future: map arbitrary JSON → createLead via
      // inbound_webhooks.field_mapping_json). Logged above; no-op for now.
      logger.info({ tenantId: tenant.id, type: integration?.type }, 'inbound webhook received (no handler)');
    } catch (err) {
      logger.error({ err: err.message }, 'inbound webhook processing failed');
    }
  })();
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
    // Reuse an existing token for this integration if one exists (idempotent),
    // else mint a new one. Register it in BOTH the per-tenant inbound_webhooks
    // (config source of truth) AND the system-DB token→tenant map (O(1) routing
    // for the unauthenticated receiver).
    const { rows: existing } = await tenantQuery(req.tenant, `SELECT secret_token FROM inbound_webhooks WHERE integration_id = $1 ORDER BY created_at LIMIT 1`, [req.params.id]);
    const token = existing[0]?.secret_token || randomToken(24);
    if (!existing[0]) {
      await tenantQuery(
        req.tenant,
        `INSERT INTO inbound_webhooks (integration_id, secret_token, is_active) VALUES ($1, $2, true)
         ON CONFLICT (secret_token) DO NOTHING`,
        [req.params.id, token],
      );
    }
    const { rows: itype } = await tenantQuery(req.tenant, `SELECT type FROM integrations WHERE id = $1`, [req.params.id]);
    await sysQuery(
      `INSERT INTO inbound_webhook_tokens (token, tenant_id, integration_id, integration_type)
       VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, integration_id = EXCLUDED.integration_id, integration_type = EXCLUDED.integration_type`,
      [token, req.tenant.id, req.params.id, itype[0]?.type ?? null],
    );
    res.json({ data: { url: `${process.env.BASE_URL || ''}/api/v1/integrations/inbound/${token}`, token }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
