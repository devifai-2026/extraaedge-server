// Cross-tenant WhatsApp access for the product_owner. Resolves any tenant by id
// and reuses the tenant-scoped inbox service against that tenant's DB. The PO
// can view messages (read-only), edit a tenant's WhatsApp config/webhook, and
// manage its locally-registered templates.
import { resolveTenantById } from '../../db/tenant.js';
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
