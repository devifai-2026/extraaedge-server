// Tenant self-branding — lets a tenant's own super_admin set their logo.
// (Distinct from /platform/tenants, which is product-owner-only.) Writes to the
// system-DB tenants row and invalidates the tenant cache so /auth/me reflects
// the new logo immediately for every role.
import * as tenantsRepo from '../tenants/repo.js';
import { invalidateTenantCache } from '../../db/tenant.js';
import { makePublic } from '../../lib/r2.js';
import { notFound } from '../../lib/errors.js';

// Update the caller's own tenant branding. `logo_r2_key` is a GCS key from a
// prior /uploads presign+confirm (purpose 'tenant_logo'); we make it public and
// store the stable URL on tenants.logo_url. Pass logo_r2_key=null to clear.
// Other branding fields (brand_name, colors) pass through if provided.
export const updateBranding = async (tenant, { logo_r2_key, ...rest }) => {
  const updates = { ...rest };

  if (logo_r2_key !== undefined) {
    updates.logo_url = logo_r2_key ? await makePublic(logo_r2_key) : null;
  }

  if (!Object.keys(updates).length) {
    const cur = await tenantsRepo.findById(tenant.id);
    if (!cur) throw notFound('Tenant not found');
    return cur;
  }

  const row = await tenantsRepo.updateById(tenant.id, updates);
  if (!row) throw notFound('Tenant not found');
  invalidateTenantCache(row.slug);
  return row;
};
