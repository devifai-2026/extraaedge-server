// Per-tenant Facebook app settings (App ID + App Secret), mirroring the
// WhatsApp wa_settings pattern. Each tenant registers its own Meta app.
import { tenantQuery } from '../../db/tenant.js';
import { encrypt, decrypt } from '../../lib/crypto.js';

// Public/read shape — App Secret is MASKED (never returned in clear).
export const getFbSettings = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT enabled, app_id, app_secret_encrypted, graph_version, updated_at FROM fb_settings WHERE id = true`,
  );
  const r = rows[0] || {};
  return {
    enabled: !!r.enabled,
    app_id: r.app_id || '',
    app_secret: r.app_secret_encrypted ? '••••••••' : '',
    graph_version: r.graph_version || 'v19.0',
    configured: !!(r.app_id && r.app_secret_encrypted),
    updated_at: r.updated_at || null,
  };
};

// Internal — returns the DECRYPTED creds for the OAuth flow. Never sent to FE.
export const getFbCreds = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT enabled, app_id, app_secret_encrypted, graph_version FROM fb_settings WHERE id = true`,
  );
  const r = rows[0] || {};
  let appSecret = '';
  try { if (r.app_secret_encrypted) appSecret = decrypt(r.app_secret_encrypted); } catch { appSecret = ''; }
  return { enabled: !!r.enabled, appId: r.app_id || '', appSecret, graphVersion: r.graph_version || 'v19.0' };
};

export const saveFbSettings = async (tenant, input) => {
  // Ignore the mask placeholder so a save without re-typing keeps the stored secret.
  const secretProvided = input.app_secret && input.app_secret !== '••••••••';
  await tenantQuery(
    tenant,
    `UPDATE fb_settings SET
       enabled = COALESCE($1, enabled),
       app_id = COALESCE($2, app_id),
       ${secretProvided ? 'app_secret_encrypted = $3,' : ''}
       graph_version = COALESCE($4, graph_version),
       updated_at = now()
     WHERE id = true`,
    secretProvided
      ? [input.enabled ?? null, input.app_id ?? null, encrypt(input.app_secret), input.graph_version ?? null]
      : [input.enabled ?? null, input.app_id ?? null, input.graph_version ?? null],
  );
  return getFbSettings(tenant);
};
