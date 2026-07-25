// App-level Facebook Lead Ads webhook. Facebook sends ALL pages' leadgen events
// to a SINGLE callback URL configured on the Meta App (App Dashboard → Webhooks
// → Page). This is UNauthenticated; we route each entry to the right tenant by
// the page id (entry[].id) via the system fb_page_tenants map.
//
//   GET  /api/v1/facebook/webhook   → hub.challenge verification handshake
//   POST /api/v1/facebook/webhook   → leadgen events (per page → per tenant)
import express from 'express';
import { sysQuery } from '../../db/system.js';
import { resolveTenantById, tenantQuery } from '../../db/tenant.js';
import { hmac, safeEqual, decrypt } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { processLeadgen } from './facebook-leads.js';

const router = express.Router();

// A stable, app-wide verify token derived from the server secret. The same
// value is shown to the user to paste into the Meta App webhook config.
export const fbVerifyToken = () => hmac(env.TENANT_SECRET_ENCRYPTION_KEY, 'facebook-webhook-verify').slice(0, 24);

// GET — Meta verification handshake.
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === fbVerifyToken()) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'verification failed' });
});

// POST — leadgen events. Capture raw body for signature verification.
router.post('/webhook', express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  res.sendStatus(200); // ACK fast; process async
  (async () => {
    try {
      const body = req.body || {};
      if (body.object !== 'page') { logger.info({ object: body.object }, 'fb webhook: non-page object ignored'); return; }

      for (const entry of body.entry || []) {
        const pageId = String(entry.id || '');
        if (!pageId) continue;
        // Route by page → tenant.
        const { rows } = await sysQuery(`SELECT tenant_id, integration_id FROM fb_page_tenants WHERE page_id = $1`, [pageId]);
        const map = rows[0];
        if (!map) { logger.warn({ pageId }, 'fb webhook: no tenant for page'); continue; }
        const tenant = await resolveTenantById(map.tenant_id).catch(() => null);
        if (!tenant) continue;

        // Load the page's integration (creds + config) for this tenant.
        const { rows: ig } = await tenantQuery(
          tenant,
          `SELECT id, type, name, credentials_encrypted, config_json FROM integrations WHERE id = $1 AND deleted_at IS NULL`,
          [map.integration_id],
        );
        const integration = ig[0];
        if (!integration) { logger.warn({ pageId, tenantId: tenant.id }, 'fb webhook: integration missing'); continue; }

        // Verify X-Hub-Signature-256 with the app secret (stored in creds).
        const appSecretEnc = integration.credentials_encrypted?.app_secret;
        if (appSecretEnc && req.rawBody) {
          try {
            const appSecret = decrypt(appSecretEnc);
            const sig = req.get('x-hub-signature-256') || '';
            const expected = `sha256=${hmac(appSecret, req.rawBody)}`;
            if (!sig || !safeEqual(sig, expected)) { logger.warn({ pageId }, 'fb webhook: bad signature'); continue; }
          } catch { /* if decrypt fails, proceed rather than drop */ }
        }

        // Log + process each leadgen change.
        await tenantQuery(
          tenant,
          `INSERT INTO webhook_events (integration_id, payload_json, status) VALUES ($1, $2::jsonb, 'pending')`,
          [integration.id, JSON.stringify(entry)],
        ).catch(() => {});
        for (const change of entry.changes || []) {
          if (change.field !== 'leadgen') continue;
          await processLeadgen(tenant, integration, integration.config_json || {}, change);
        }
      }
    } catch (err) {
      logger.error({ err: err.message }, 'fb webhook processing failed');
    }
  })();
});

export default router;
