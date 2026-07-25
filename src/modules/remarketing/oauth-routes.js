// Facebook "Connect with Facebook" OAuth flow — PER-TENANT app credentials
// (each tenant registers its own Meta app in fb_settings, like WhatsApp).
//   GET /remarketing/oauth/start   (AUTHED) → FB dialog URL (signed state).
//   GET /remarketing/oauth/callback (UNAUTHED — FB browser redirect) → validate
//        state, load the tenant's fb creds, exchange code for a long-lived
//        token, store ad accounts + pages per-tenant, subscribe pages to
//        leadgen, then close the popup.
//
// State is signed with TENANT_SECRET_ENCRYPTION_KEY (a stable server secret that
// always exists) — NOT the FB app secret — so the unauthenticated callback can
// verify which tenant initiated the flow before loading that tenant's FB creds.
import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { resolveTenantById, tenantQuery } from '../../db/tenant.js';
import { encrypt, hmac, safeEqual } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { getFbCreds } from './fb-settings.js';
import {
  buildOAuthDialogUrl, exchangeCodeForToken, listAdAccounts, listPages, subscribePageToLeadgen,
} from '../../lib/providers/facebook-graph.js';

const router = express.Router();

const STATE_SECRET = env.TENANT_SECRET_ENCRYPTION_KEY; // always present
const redirectBase = () => (env.FB_OAUTH_REDIRECT_BASE || env.BASE_URL || '').replace(/\/+$/, '');
const redirectUri = () => `${redirectBase()}/api/v1/remarketing/oauth/callback`;

const signState = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(STATE_SECRET, body)}`;
};
const verifyState = (state) => {
  try {
    const [body, sig] = String(state).split('.');
    if (!body || !sig) return null;
    if (!safeEqual(sig, hmac(STATE_SECRET, body))) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.ts || Date.now() - data.ts > 10 * 60_000) return null;
    return data;
  } catch { return null; }
};

// ── START (authed) — uses the CURRENT tenant's own FB app ──
router.get('/oauth/start', authRequired, tenantRequired,
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER),
  async (req, res, next) => {
    try {
      const creds = await getFbCreds(req.tenant);
      if (!creds.appId || !creds.appSecret) {
        return res.status(400).json({ error: { code: 'FB_NOT_CONFIGURED', message: 'Add your Facebook App ID and App Secret in Settings → Facebook first.' } });
      }
      const state = signState({ t: req.tenant.id, u: req.user.id, ts: Date.now() });
      const url = buildOAuthDialogUrl({ appId: creds.appId, redirectUri: redirectUri(), state });
      res.json({ data: { url }, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  });

const closePopup = (ok, message) => `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px">
<p>${ok ? '✅ Facebook connected. You can close this window.' : `❌ ${message || 'Connection failed.'}`}</p>
<script>try{window.opener&&window.opener.postMessage({source:'fb-oauth',ok:${ok ? 'true' : 'false'}},'*')}catch(e){}setTimeout(function(){window.close()},1500)</script>
</body>`;

// ── CALLBACK (unauthed — FB browser redirect) — loads the tenant's FB creds ──
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(200).send(closePopup(false, String(error)));
  const st = verifyState(state);
  if (!st || !code) return res.status(400).send(closePopup(false, 'Invalid or expired state.'));

  const tenant = await resolveTenantById(st.t).catch(() => null);
  if (!tenant) return res.status(400).send(closePopup(false, 'Unknown tenant.'));

  try {
    const creds = await getFbCreds(tenant);
    if (!creds.appId || !creds.appSecret) return res.status(400).send(closePopup(false, 'Facebook app not configured.'));

    const { accessToken } = await exchangeCodeForToken({
      appId: creds.appId, appSecret: creds.appSecret, redirectUri: redirectUri(), code,
    });

    const adAccounts = await listAdAccounts(accessToken);
    for (const a of adAccounts) {
      await tenantQuery(
        tenant,
        `INSERT INTO fb_ad_accounts (ad_account_id, name, access_token_encrypted, connected_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (ad_account_id) DO UPDATE SET name = EXCLUDED.name, access_token_encrypted = EXCLUDED.access_token_encrypted, deleted_at = NULL`,
        [a.id, a.name || a.account_id || a.id, encrypt(accessToken), st.u],
      ).catch((e) => logger.warn({ err: e.message }, 'store ad account failed'));
    }

    const pages = await listPages(accessToken);
    for (const pg of pages) {
      if (!pg.access_token) continue;
      const credsBlob = { page_access_token: encrypt(pg.access_token), app_secret: encrypt(creds.appSecret) };
      await tenantQuery(
        tenant,
        `INSERT INTO integrations (type, name, credentials_encrypted, config_json, status, created_by)
         VALUES ('facebook_ads', $1, $2::jsonb, $3::jsonb, 'published', $4)
         ON CONFLICT DO NOTHING`,
        [
          `Facebook Page: ${pg.name}`,
          JSON.stringify(credsBlob),
          JSON.stringify({ page_id: pg.id, default_channel: 'Facebook', default_source: 'Facebook Lead Ads', verify_token: hmac(STATE_SECRET, pg.id).slice(0, 24) }),
          st.u,
        ],
      ).catch((e) => logger.warn({ err: e.message }, 'store fb page integration failed'));
      await subscribePageToLeadgen(pg.id, pg.access_token).catch(() => {});
    }

    logger.info({ tenantId: tenant.id, adAccounts: adAccounts.length, pages: pages.length }, 'FB OAuth connected');
    return res.status(200).send(closePopup(true));
  } catch (err) {
    logger.error({ err: err.message }, 'FB OAuth callback failed');
    return res.status(200).send(closePopup(false, 'Token exchange failed.'));
  }
});

export default router;
