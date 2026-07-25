// Remarketing sync worker — pushes CRM lead segments to Facebook Custom
// Audiences. Polls every active tenant for fb_audiences with sync_status
// 'pending', resolves the segment via the shared audience resolver, hashes
// emails/phones, and pushes them to a FB Custom Audience via the Marketing API.
// Per-tenant tokens live in fb_ad_accounts.access_token_encrypted.
import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { decrypt } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { resolveAudienceLeads } from '../lib/audience.js';
import { createCustomAudience, addUsersToAudience } from '../lib/providers/facebook-graph.js';

const POLL_MS = 60_000;

const syncOne = async (tenant, aud) => {
  // Load the ad account + token.
  const { rows: acctRows } = await tenantQuery(
    tenant,
    `SELECT ad_account_id, access_token_encrypted FROM fb_ad_accounts WHERE id = $1 AND deleted_at IS NULL`,
    [aud.fb_ad_account_id],
  );
  const acct = acctRows[0];
  if (!acct) {
    await tenantQuery(tenant, `UPDATE fb_audiences SET sync_status = 'failed' WHERE id = $1`, [aud.id]);
    return;
  }
  let token;
  try { token = decrypt(acct.access_token_encrypted); } catch { token = null; }
  if (!token) {
    await tenantQuery(tenant, `UPDATE fb_audiences SET sync_status = 'failed' WHERE id = $1`, [aud.id]);
    return;
  }

  // Resolve the segment leads.
  const leads = await resolveAudienceLeads(tenantQuery, tenant, aud.audience_filter_json || {});

  // Create the FB audience if we don't have one yet.
  let fbAudienceId = aud.fb_audience_id;
  if (!fbAudienceId) {
    fbAudienceId = await createCustomAudience({
      adAccountId: acct.ad_account_id, accessToken: token, name: aud.name, description: aud.description,
    });
  }
  // Push users (chunk to keep requests reasonable).
  const CHUNK = 5000;
  for (let i = 0; i < leads.length; i += CHUNK) {
    await addUsersToAudience({ audienceId: fbAudienceId, accessToken: token, leads: leads.slice(i, i + CHUNK) });
  }

  await tenantQuery(
    tenant,
    `UPDATE fb_audiences SET sync_status = 'synced', fb_audience_id = $2, lead_count = $3, last_synced_at = now() WHERE id = $1`,
    [aud.id, fbAudienceId, leads.length],
  );
  logger.info({ tenantId: tenant.id, audienceId: aud.id, fbAudienceId, count: leads.length }, 'FB audience synced');
};

const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const t of tenants) {
      const tenant = await resolveTenantById(t.id).catch(() => null);
      if (!tenant) continue;
      let pending = [];
      try {
        const { rows } = await tenantQuery(
          tenant,
          `SELECT id, fb_ad_account_id, name, description, audience_filter_json, fb_audience_id
             FROM fb_audiences WHERE sync_status = 'pending' AND deleted_at IS NULL LIMIT 20`,
        );
        pending = rows;
      } catch { continue; } // tenant may not have the table yet
      for (const aud of pending) {
        try { await syncOne(tenant, aud); }
        catch (err) {
          logger.error({ tenantId: tenant.id, audienceId: aud.id, err: err.message }, 'FB audience sync failed');
          await tenantQuery(tenant, `UPDATE fb_audiences SET sync_status = 'failed' WHERE id = $1`, [aud.id]).catch(() => {});
        }
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'remarketing-sync tick failed');
  }
};

setTimeout(tick, 10_000);
setInterval(tick, POLL_MS);
logger.info('remarketing-sync worker started');
