// Facebook "Connect with Facebook" OAuth flow. Two endpoints:
//   GET /remarketing/oauth/start   (AUTHED) → returns the FB dialog URL with a
//        signed state carrying tenant+user. The FE opens it in a popup.
//   GET /remarketing/oauth/callback (UNAUTHED — FB redirects the browser here
//        with ?code&state). We validate state, exchange the code for a
//        long-lived token, fetch the user's ad accounts + pages, store them
//        per-tenant, subscribe pages to leadgen, and return a tiny HTML page
//        that messages the opener and closes the popup.
//
// State is an HMAC-signed, time-bounded token so the unauthenticated callback
// can trust which tenant/user initiated the flow (the FB redirect can't carry
// our JWT).
import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { resolveTenantById, tenantQuery } from '../../db/tenant.js';
import { encrypt, hmac, safeEqual } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import {
  buildOAuthDialogUrl, exchangeCodeForToken, listAdAccounts, listPages, subscribePageToLeadgen,
} from '../../lib/providers/facebook-graph.js';

const router = express.Router();

const redirectBase = () => (env.FB_OAUTH_REDIRECT_BASE || env.BASE_URL || '').replace(/\/+$/, '');
const redirectUri = () => `${redirectBase()}/api/v1/remarketing/oauth/callback`;

// state = base64url(json).sig  where sig = hmac(APP_SECRET, base64url(json))
const signState = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(env.FB_APP_SECRET, body)}`;
};
const verifyState = (state) => {
  try {
    const [body, sig] = String(state).split('.');
    if (!body || !sig) return null;
    if (!safeEqual(sig, hmac(env.FB_APP_SECRET, body))) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.ts || Date.now() - data.ts > 10 * 60_000) return null; // 10-min window
    return data;
  } catch { return null; }
};

// ── START (authed) ──
router.get('/oauth/start', authRequired, tenantRequired,
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER),
  (req, res, next) => {
    try {
      if (!env.FB_APP_ID || !env.FB_APP_SECRET) {
        return res.status(400).json({ error: { code: 'FB_NOT_CONFIGURED', message: 'Facebook app is not configured on the server (FB_APP_ID/FB_APP_SECRET).' } });
      }
      const state = signState({ t: req.tenant.id, u: req.user.id, ts: Date.now() });
      const url = buildOAuthDialogUrl({ appId: env.FB_APP_ID, redirectUri: redirectUri(), state });
      res.json({ data: { url }, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  });

// Tiny HTML that notifies the opener window and closes the popup.
const closePopup = (ok, message) => `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px">
<p>${ok ? '✅ Facebook connected. You can close this window.' : `❌ ${message || 'Connection failed.'}`}</p>
<script>try{window.opener&&window.opener.postMessage({source:'fb-oauth',ok:${ok ? 'true' : 'false'}},'*')}catch(e){}setTimeout(function(){window.close()},1500)</script>
</body>`;

// ── CALLBACK (unauthed — FB browser redirect) ──
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(200).send(closePopup(false, String(error)));
  const st = verifyState(state);
  if (!st || !code) return res.status(400).send(closePopup(false, 'Invalid or expired state.'));

  const tenant = await resolveTenantById(st.t).catch(() => null);
  if (!tenant) return res.status(400).send(closePopup(false, 'Unknown tenant.'));

  try {
    const { accessToken } = await exchangeCodeForToken({
      appId: env.FB_APP_ID, appSecret: env.FB_APP_SECRET, redirectUri: redirectUri(), code,
    });

    // Store each ad account the user can manage (per-tenant, encrypted token).
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

    // Store Pages + their page tokens for Lead Ads, and subscribe to leadgen.
    // Persisted as a facebook_ads integration so the inbound webhook can use it.
    const pages = await listPages(accessToken);
    for (const pg of pages) {
      if (!pg.access_token) continue;
      const creds = { page_access_token: encrypt(pg.access_token), app_secret: encrypt(env.FB_APP_SECRET) };
      await tenantQuery(
        tenant,
        `INSERT INTO integrations (type, name, credentials_encrypted, config_json, status, created_by)
         VALUES ('facebook_ads', $1, $2::jsonb, $3::jsonb, 'published', $4)
         ON CONFLICT DO NOTHING`,
        [
          `Facebook Page: ${pg.name}`,
          JSON.stringify(creds),
          JSON.stringify({ page_id: pg.id, default_channel: 'Facebook', default_source: 'Facebook Lead Ads', verify_token: hmac(env.FB_APP_SECRET, pg.id).slice(0, 24) }),
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
