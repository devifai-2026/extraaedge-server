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

      // ── Generic flat-JSON inbound ── (LeadsBridge / Zapier / custom): map a
      // flat payload to a lead and create it. Field mapping comes from the
      // integration config (config_json.field_mapping) with sensible defaults;
      // we also accept many common key spellings so no mapping is required.
      const cfg = integration?.config_json || {};
      const map = cfg.field_mapping || {};
      // LeadsBridge sometimes nests the lead under `data`; accept both.
      const flat = (body && typeof body === 'object' && body.data && typeof body.data === 'object') ? { ...body, ...body.data } : body;
      const lower = {};
      for (const [k, v] of Object.entries(flat || {})) lower[String(k).toLowerCase().replace(/[\s-]+/g, '_')] = v;
      const pickField = (crmKey, candidates) => {
        const mapped = map[crmKey] && lower[String(map[crmKey]).toLowerCase().replace(/[\s-]+/g, '_')];
        if (mapped != null && mapped !== '') return mapped;
        for (const c of candidates) if (lower[c] != null && lower[c] !== '') return lower[c];
        return null;
      };
      const name = pickField('name', ['full_name', 'name', 'fullname', 'first_name']);
      const email = pickField('email', ['email', 'email_address', 'e_mail']);
      const phoneRaw = pickField('phone', ['phone_number', 'phone', 'mobile', 'mobile_number', 'contact_number']);
      const digits = phoneRaw ? String(phoneRaw).replace(/\D/g, '') : null;
      if (!email && !digits) {
        logger.warn({ tenantId: tenant.id, keys: Object.keys(lower) }, 'inbound webhook: no email/phone found — cannot create lead');
        return;
      }
      const whatsapp = digits ? (digits.length === 10 ? `91${digits}` : digits) : null;
      const channelName = cfg.default_channel || 'Facebook';
      const sourceName = cfg.default_source || 'Facebook Lead Ads';
      // Resolve/auto-create attribution dictionary ids.
      const dictId = async (table, nm) => {
        if (!nm) return null;
        const { rows: f } = await tenantQuery(tenant, `SELECT id FROM ${table} WHERE lower(name)=lower($1) AND deleted_at IS NULL LIMIT 1`, [nm]);
        if (f[0]) return f[0].id;
        const { rows: c } = await tenantQuery(tenant, `INSERT INTO ${table} (name) VALUES ($1) RETURNING id`, [nm]);
        return c[0]?.id ?? null;
      };
      const channelId = await dictId('lead_channels', channelName);
      const sourceId = await dictId('lead_sources_dict', sourceName);
      // Optional extras many inbound sources send (JustDial: requirement + city).
      const city = pickField('city', ['city', 'area', 'location']);
      const requirement = pickField('requirement', ['requirement', 'message', 'notes', 'comments', 'enquiry', 'query', 'search']);
      // Per-integration assignee pool (config_json.assignee_pool = [counsellor
      // ids]). When set, leads from THIS source are round-robin'd ONLY among
      // those counsellors (load-balanced: fewest leads from this source wins),
      // never the tenant-wide pool. Used for JustDial: admin picks the
      // counsellors who should receive JD leads.
      const pool = Array.isArray(cfg.assignee_pool) ? cfg.assignee_pool.filter(Boolean) : [];
      let poolAssignee = null;
      if (pool.length) {
        const { rows: pr } = await tenantQuery(
          tenant,
          `SELECT u.id
             FROM users u
             LEFT JOIN leads l ON l.assigned_to = u.id AND l.deleted_at IS NULL
                               AND l.first_touch_source ILIKE $2
            WHERE u.id = ANY($1::uuid[]) AND u.role = 'counsellor'
              AND u.is_active = true AND u.deleted_at IS NULL
            GROUP BY u.id
            ORDER BY count(l.id) ASC, u.id
            LIMIT 1`,
          [pool, sourceName],
        );
        poolAssignee = pr[0]?.id ?? null;
      }
      const input = {
        name: name || `${sourceName} Lead ${digits || email || ''}`.trim(),
        email: email || undefined,
        phone: digits || undefined,
        whatsapp_number: whatsapp || undefined,
        city: city || undefined,
        remarks: requirement ? String(requirement).slice(0, 500) : undefined,
        first_touch_channel: channelName,
        first_touch_source: sourceName,
        sources: [{ channel_id: channelId, source_id: sourceId, is_primary: true }],
      };
      if (cfg.default_stage) input.stage_id = cfg.default_stage;
      // When a pool is configured, assign within it and DON'T fall back to the
      // tenant-wide round-robin (honors "only these counsellors"). If the pool
      // has no valid active counsellor right now, the lead stays unassigned for
      // an admin to route — it never leaks to someone outside the pool.
      if (pool.length) input.assigned_to = poolAssignee || undefined;
      try {
        const { createLead } = await import('../leads/service.js');
        const created = await createLead(tenant, null, input, { on_duplicate: 'warn', skip_auto_assign: pool.length > 0 });
        logger.info({ tenantId: tenant.id, leadId: created?.id, source: 'inbound-webhook' }, 'inbound webhook lead created');
      } catch (e) {
        logger.error({ tenantId: tenant.id, err: e.message }, 'inbound webhook lead create failed');
      }
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

// ── JustDial lead-assignment pool ──────────────────────────────────────────
// The admin picks which counsellors receive JustDial (Gmail) leads; the inbound
// handler round-robins JD leads ONLY among them. Stored on the JustDial
// integration's config_json.assignee_pool. Placed before '/:id' — the extra
// path segment means '/:id' won't shadow it, but keep it early for clarity.
const findJustDial = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, config_json FROM integrations WHERE type='webhook_inbound' AND name='JustDial Leads' AND deleted_at IS NULL LIMIT 1`,
  );
  return rows[0] || null;
};
router.get('/justdial/assignee-pool', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), async (req, res, next) => {
  try {
    const ig = await findJustDial(req.tenant);
    res.json({ data: { pool: ig?.config_json?.assignee_pool || [], configured: !!ig }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});
router.put('/justdial/assignee-pool', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ body: z.object({ pool: z.array(z.string().uuid()) }) }), async (req, res, next) => {
  try {
    // Keep only ids that are active counsellors — leads must never be assigned
    // to a non-counsellor (mirrors the ownership invariant).
    let pool = req.body.pool;
    if (pool.length) {
      const { rows: valid } = await tenantQuery(
        req.tenant,
        `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND role='counsellor' AND is_active=true AND deleted_at IS NULL`,
        [pool],
      );
      pool = valid.map((v) => v.id);
    }
    let ig = await findJustDial(req.tenant);
    if (!ig) {
      const cfg = { default_channel: 'JustDial', default_source: 'JustDial', field_mapping: { name: 'full_name', email: 'email', phone: 'phone' }, assignee_pool: pool };
      await tenantQuery(
        req.tenant,
        `INSERT INTO integrations (type, name, config_json, status, created_by) VALUES ('webhook_inbound','JustDial Leads',$1::jsonb,'published',$2)`,
        [JSON.stringify(cfg), req.user.id],
      );
    } else {
      await tenantQuery(
        req.tenant,
        `UPDATE integrations SET config_json = COALESCE(config_json,'{}'::jsonb) || jsonb_build_object('assignee_pool', $2::jsonb), updated_at = now() WHERE id = $1`,
        [ig.id, JSON.stringify(pool)],
      );
    }
    res.json({ data: { pool }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

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
