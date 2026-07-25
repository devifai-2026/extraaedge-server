// Facebook Graph / Marketing API client. Per-tenant: every call takes the
// tenant's own access token (Page token for Lead Ads, System-User/ad-account
// token for Custom Audiences). No global FB env — tokens live in the tenant's
// integrations.credentials_encrypted / fb_ad_accounts.access_token_encrypted.
import crypto from 'crypto';
import { logger } from '../logger.js';

const API_VERSION = 'v19.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

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
