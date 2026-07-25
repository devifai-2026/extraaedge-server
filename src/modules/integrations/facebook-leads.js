// Facebook Lead Ads inbound handler. Given a tenant + integration config + a
// leadgen webhook change, fetches the full lead from the Graph API, maps FB
// fields to CRM lead fields, resolves/auto-creates the marketing attribution
// (channel='Facebook' + campaign), and creates the lead via the single
// createLead() seam (which round-robin-assigns via the tenant's assignment rule).
import { tenantQuery } from '../../db/tenant.js';
import { decrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { fetchLeadgen, flattenFieldData } from '../../lib/providers/facebook-graph.js';

// Decrypt the Page access token from an integration's credentials blob.
// credentials_encrypted is { key: <ciphertext>, ... }.
export const pageTokenFromIntegration = (integration) => {
  try {
    const creds = integration?.credentials_encrypted || {};
    const enc = creds.page_access_token || creds.access_token || creds.token;
    return enc ? decrypt(enc) : null;
  } catch { return null; }
};

// Resolve (or auto-create) a dictionary row id by name.
const resolveDictId = async (tenant, table, name) => {
  if (!name) return null;
  const { rows: found } = await tenantQuery(tenant, `SELECT id FROM ${table} WHERE lower(name) = lower($1) AND deleted_at IS NULL LIMIT 1`, [String(name).trim()]);
  if (found[0]) return found[0].id;
  const { rows: created } = await tenantQuery(tenant, `INSERT INTO ${table} (name) VALUES ($1) RETURNING id`, [String(name).trim()]);
  return created[0]?.id ?? null;
};

// Default FB field name → CRM lead field. Overridable via integration
// config_json.field_mapping ({ crmField: fbFieldName }).
const DEFAULT_MAP = {
  name: ['full_name', 'name'],
  email: ['email'],
  phone: ['phone_number', 'phone'],
};

const pick = (flat, candidates) => {
  for (const c of candidates) if (flat[c] != null && flat[c] !== '') return flat[c];
  return null;
};

// Process one leadgen change. `config` = integration.config_json.
export const processLeadgen = async (tenant, integration, config, change) => {
  const value = change?.value || {};
  const leadgenId = value.leadgen_id || value.leadgenId;
  const fbCampaignName = value.campaign_name || value.adgroup_name || null;
  if (!leadgenId) { logger.warn({ tenantId: tenant.id }, 'FB leadgen: no leadgen_id in change'); return; }

  const token = pageTokenFromIntegration(integration);
  if (!token) { logger.warn({ tenantId: tenant.id }, 'FB leadgen: no page token configured'); return; }

  const lead = await fetchLeadgen(leadgenId, token);
  if (!lead) return;
  const flat = flattenFieldData(lead);

  // Field mapping (config override or defaults).
  const mapping = config?.field_mapping || {};
  const name = flat[String(mapping.name || '').toLowerCase()] || pick(flat, DEFAULT_MAP.name);
  const email = flat[String(mapping.email || '').toLowerCase()] || pick(flat, DEFAULT_MAP.email);
  const phone = flat[String(mapping.phone || '').toLowerCase()] || pick(flat, DEFAULT_MAP.phone);

  const digits = phone ? String(phone).replace(/\D/g, '') : null;
  const whatsapp = digits ? (digits.length === 10 ? `91${digits}` : digits) : null;

  // Attribution: channel = Facebook (or config default), source, campaign.
  const channelName = config?.default_channel || 'Facebook';
  const sourceName = config?.default_source || 'Facebook Lead Ads';
  const channelId = await resolveDictId(tenant, 'lead_channels', channelName);
  const sourceId = await resolveDictId(tenant, 'lead_sources_dict', sourceName);
  const campaignId = fbCampaignName ? await resolveDictId(tenant, 'lead_campaigns_dict', fbCampaignName) : null;

  const input = {
    name: name || `Facebook Lead ${digits || leadgenId}`,
    email: email || undefined,
    phone: digits || undefined,
    whatsapp_number: whatsapp || undefined,
    first_touch_channel: channelName,
    first_touch_source: sourceName,
    ...(campaignId ? { first_touch_campaign_id: campaignId } : {}),
    sources: [{
      channel_id: channelId, source_id: sourceId, campaign_id: campaignId, is_primary: true,
    }],
  };
  if (config?.default_stage) input.stage_id = config.default_stage;

  try {
    const { createLead } = await import('../leads/service.js');
    // Null actor → tenant-wide round-robin via the assignment rule.
    const created = await createLead(tenant, null, input, { on_duplicate: 'warn' });
    logger.info({ tenantId: tenant.id, leadgenId, leadId: created?.id }, 'FB lead created');
    return created?.id ?? null;
  } catch (err) {
    logger.error({ tenantId: tenant.id, leadgenId, err: err.message }, 'FB lead create failed');
    return null;
  }
};
