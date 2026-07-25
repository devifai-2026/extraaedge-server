// Facebook Graph / Marketing API client. Per-tenant: every call takes the
// tenant's own access token (Page token for Lead Ads, System-User/ad-account
// token for Custom Audiences). No global FB env — tokens live in the tenant's
// integrations.credentials_encrypted / fb_ad_accounts.access_token_encrypted.
import crypto from 'crypto';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';

const API_VERSION = env.FB_GRAPH_VERSION || 'v19.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

// ── OAuth "Connect with Facebook" ──────────────────────────────────────────
// Scopes needed: ads_management (Custom Audiences), leads_retrieval + pages_*
// (Lead Ads inbound). business_management helps list assets.
export const OAUTH_SCOPES = [
  'ads_management',
  'ads_read',
  'leads_retrieval',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'business_management',
].join(',');

// Build the FB OAuth dialog URL the browser is sent to.
export const buildOAuthDialogUrl = ({ appId, redirectUri, state }) => {
  const p = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    scope: OAUTH_SCOPES,
    response_type: 'code',
  });
  return `https://www.facebook.com/${API_VERSION}/dialog/oauth?${p.toString()}`;
};

// Exchange an OAuth code for a short-lived token, then upgrade to a long-lived one.
export const exchangeCodeForToken = async ({ appId, appSecret, redirectUri, code }) => {
  const shortRes = await fetch(`${GRAPH}/oauth/access_token?${new URLSearchParams({
    client_id: appId, redirect_uri: redirectUri, client_secret: appSecret, code,
  })}`);
  const shortData = await shortRes.json().catch(() => null);
  if (!shortRes.ok || !shortData?.access_token) {
    throw new Error(`FB code exchange failed: ${shortRes.status} ${JSON.stringify(shortData)}`);
  }
  // Upgrade to long-lived (≈60 days).
  const longRes = await fetch(`${GRAPH}/oauth/access_token?${new URLSearchParams({
    grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortData.access_token,
  })}`);
  const longData = await longRes.json().catch(() => null);
  return { accessToken: longData?.access_token || shortData.access_token, expiresIn: longData?.expires_in || null };
};

// List the ad accounts the token can manage: [{ id:'act_123', name, account_id }].
export const listAdAccounts = async (accessToken) => {
  const res = await fetch(`${GRAPH}/me/adaccounts?fields=name,account_id&access_token=${encodeURIComponent(accessToken)}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) { logger.warn({ status: res.status, body: data }, 'FB listAdAccounts failed'); return []; }
  return data?.data || [];
};

// List the Pages (with their page access tokens) for Lead Ads:
// [{ id, name, access_token }].
export const listPages = async (userAccessToken) => {
  const res = await fetch(`${GRAPH}/me/accounts?fields=name,access_token&access_token=${encodeURIComponent(userAccessToken)}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) { logger.warn({ status: res.status, body: data }, 'FB listPages failed'); return []; }
  return data?.data || [];
};

// Subscribe a Page to leadgen webhooks (so Lead Ads submissions fire our webhook).
export const subscribePageToLeadgen = async (pageId, pageAccessToken) => {
  const res = await fetch(`${GRAPH}/${pageId}/subscribed_apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscribed_fields: 'leadgen', access_token: pageAccessToken }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) logger.warn({ pageId, status: res.status, body: data }, 'FB subscribePageToLeadgen failed');
  return res.ok;
};

// Fetch the full field data for a Lead Ads submission by its leadgen_id.
// Returns { id, created_time, field_data: [{name, values:[...]}], ...} or null.
export const fetchLeadgen = async (leadgenId, accessToken) => {
  try {
    const url = `${GRAPH}/${leadgenId}?access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      logger.warn({ leadgenId, status: res.status, body: data }, 'FB fetchLeadgen failed');
      return null;
    }
    return data;
  } catch (err) {
    logger.error({ leadgenId, err: err.message }, 'FB fetchLeadgen error');
    return null;
  }
};

// Flatten FB field_data ([{name, values}]) into a plain { name: value } object.
export const flattenFieldData = (lead) => {
  const out = {};
  for (const f of lead?.field_data || []) {
    out[String(f.name).toLowerCase()] = Array.isArray(f.values) ? f.values[0] : f.values;
  }
  return out;
};

// SHA-256 hash (lowercased, trimmed) — required format for Custom Audience users.
const hashNorm = (v) => (v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : null);

// Create (or reuse) a Custom Audience on an ad account and return its id.
// adAccountId like 'act_1234' (we prefix 'act_' if missing).
export const createCustomAudience = async ({ adAccountId, accessToken, name, description }) => {
  const acct = String(adAccountId).startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const res = await fetch(`${GRAPH}/${acct}/customaudiences`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      description: description || 'ExtraaEdge CRM segment',
      subtype: 'CUSTOM',
      customer_file_source: 'USER_PROVIDED_ONLY',
      access_token: accessToken,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`FB create audience failed: ${res.status} ${JSON.stringify(data)}`);
  return data.id;
};

// Push users (emails + phones) to a Custom Audience. Hashes per FB spec.
// leads: [{ email, phone }]. Returns the API response.
export const addUsersToAudience = async ({ audienceId, accessToken, leads }) => {
  const schema = ['EMAIL', 'PHONE'];
  const dataRows = leads.map((l) => [hashNorm(l.email), hashNorm(l.phone || l.whatsapp_number)]);
  const res = await fetch(`${GRAPH}/${audienceId}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      payload: { schema, data: dataRows },
      access_token: accessToken,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`FB add users failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
};

// Lightweight token/asset check for the "test connection" button.
export const verifyToken = async (accessToken) => {
  try {
    const res = await fetch(`${GRAPH}/me?access_token=${encodeURIComponent(accessToken)}`);
    return res.ok;
  } catch { return false; }
};
