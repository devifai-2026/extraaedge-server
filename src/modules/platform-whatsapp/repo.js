// Cross-tenant WhatsApp access for the product_owner. Resolves any tenant by id
// and reuses the tenant-scoped inbox service against that tenant's DB. The PO
// can view messages (read-only), edit a tenant's WhatsApp config/webhook, and
// manage its locally-registered templates.
import { resolveTenantById, tenantQuery } from '../../db/tenant.js';
import { tenantNotFound } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import * as inbox from '../communications/whatsapp-inbox/service.js';

const requireTenant = async (tenantId) => {
  const tenant = await resolveTenantById(tenantId);
  if (!tenant) throw tenantNotFound();
  return tenant;
};

const webhookUrl = (tenant) => `${env.BASE_URL}/api/v1/whatsapp/webhook/${tenant.slug}`;

export const getSettings = async (tenantId) => {
  const tenant = await requireTenant(tenantId);
  const s = await inbox.getSettings(tenant);
  return {
    enabled: s.enabled,
    app_key: s.appKey,
    auth_key: s.authKey ? '••••••••' : '',
    device_id: s.deviceId,
    business_phone: s.businessPhone,
    webhook_url: webhookUrl(tenant),
    configured: !!(s.appKey && s.authKey && s.deviceId),
  };
};

export const saveSettings = async (tenantId, input) => {
  const tenant = await requireTenant(tenantId);
  const saved = await inbox.saveSettings(tenant, {
    enabled: input.enabled,
    appKey: input.app_key,
    authKey: input.auth_key && input.auth_key !== '••••••••' ? input.auth_key : undefined,
    deviceId: input.device_id,
    businessPhone: input.business_phone,
  });
  return { webhook_url: webhookUrl(tenant), configured: !!(saved.appKey && saved.authKey && saved.deviceId) };
};

// PO: delete a tenant's WhatsApp config. Clears keys + disables the
// integration so the tenant's admin UI shows "not configured".
export const clearSettings = async (tenantId) => {
  const tenant = await requireTenant(tenantId);
  const s = await inbox.clearSettings(tenant);
  return { enabled: s.enabled, configured: !!(s.appKey && s.authKey && s.deviceId), webhook_url: webhookUrl(tenant) };
};

// The PO is cross-tenant all-access → view every chat (super_admin-equivalent).
const ALL_ACCESS = { role: 'super_admin', id: null };

export const listChats = async (tenantId) => {
  const tenant = await requireTenant(tenantId);
  return inbox.listChats(tenant, ALL_ACCESS);
};

export const listMessages = async (tenantId, phone) => {
  const tenant = await requireTenant(tenantId);
  return inbox.listMessages(tenant, ALL_ACCESS, phone);
};

export const listTemplates = async (tenantId) => {
  const tenant = await requireTenant(tenantId);
  return inbox.listTemplates(tenant);
};

export const addTemplate = async (tenantId, input) => {
  const tenant = await requireTenant(tenantId);
  // created_by is null: a PO is a platform user, not a row in the tenant's
  // users table (the FK would fail otherwise).
  return inbox.addTemplate(tenant, input, null);
};

export const deleteTemplate = async (tenantId, id) => {
  const tenant = await requireTenant(tenantId);
  await inbox.deleteTemplate(tenant, id);
};

// Raw webhook / API payload log (inbound + outbound), newest first.
// `direction` filter is optional ('inbound' | 'outbound'). `since` (ISO string)
// limits to rows created on/after that instant (used by the last-24h / last-7d
// quick filters).
export const listWebhookLogs = async (tenantId, { direction = null, since = null, limit = 100 } = {}) => {
  const tenant = await requireTenant(tenantId);
  const conds = [];
  const params = [];
  if (direction === 'inbound' || direction === 'outbound') {
    params.push(direction);
    conds.push(`direction = $${params.length}`);
  }
  if (since) {
    params.push(since);
    conds.push(`created_at >= $${params.length}::timestamptz`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(Math.min(Number(limit) || 100, 1000));
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, direction, event, endpoint, phone, status_code, ok,
            request_json, response_json, error, created_at
       FROM wa_webhook_logs ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  ).catch((err) => {
    // Table may not exist yet on a tenant that hasn't run the migration.
    if (err?.code === '42P01') return { rows: [] };
    throw err;
  });
  return rows;
};

// Aggregate counts for the Webhooks tab graphs:
//   hourly — last 24h in 1-hour buckets (inbound vs outbound)
//   daily  — last 7 days in 1-day buckets (inbound vs outbound)
// Both series are gap-filled so the chart has a continuous x-axis.
export const webhookLogStats = async (tenantId) => {
  const tenant = await requireTenant(tenantId);
  const run = async (bucket, interval, step) => {
    const { rows } = await tenantQuery(
      tenant,
      `SELECT to_char(g.b, $1) AS label,
              COALESCE(i.n, 0)::int AS inbound,
              COALESCE(o.n, 0)::int AS outbound
         FROM generate_series(
                date_trunc($2, now()) - $3::interval,
                date_trunc($2, now()), ('1 ' || $2)::interval) g(b)
         LEFT JOIN (
           SELECT date_trunc($2, created_at) b, count(*) n
             FROM wa_webhook_logs
            WHERE direction = 'inbound' AND created_at >= now() - $3::interval
            GROUP BY 1) i ON i.b = g.b
         LEFT JOIN (
           SELECT date_trunc($2, created_at) b, count(*) n
             FROM wa_webhook_logs
            WHERE direction = 'outbound' AND created_at >= now() - $3::interval
            GROUP BY 1) o ON o.b = g.b
        ORDER BY g.b`,
      [bucket, step, interval],
    );
    return rows;
  };
  try {
    const [hourly, daily] = await Promise.all([
      run('HH24:00', '24 hours', 'hour'),
      run('Mon DD', '7 days', 'day'),
    ]);
    return { hourly, daily };
  } catch (err) {
    if (err?.code === '42P01') return { hourly: [], daily: [] };
    throw err;
  }
};
