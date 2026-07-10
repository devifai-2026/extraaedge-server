// Tenant self-branding — lets a tenant's own super_admin set their logo.
// (Distinct from /platform/tenants, which is product-owner-only.) Writes to the
// system-DB tenants row and invalidates the tenant cache so /auth/me reflects
// the new logo immediately for every role.
import { createHash } from 'crypto';
import * as tenantsRepo from '../tenants/repo.js';
import { invalidateTenantCache } from '../../db/tenant.js';
import { notFound } from '../../lib/errors.js';

// The logo lives in a PRIVATE bucket, so we DON'T hand out a raw storage URL
// (it 403s under uniform bucket-level access). Instead we persist the opaque
// GCS key and point logo_url at our own streaming proxy
// (GET /public/branding/:slug/logo). We store a ROOT-RELATIVE path (no host)
// so the value is environment-independent — the frontend prefixes it with
// whichever backend host it's talking to (localhost in dev, the Render host in
// prod), so a URL saved in one environment renders correctly in the other.
// A ?v=<hash-of-key> query busts the CDN / browser cache whenever the logo
// changes (new key -> new hash -> new URL).
const proxyLogoUrl = (slug, key) => {
  const v = createHash('sha1').update(key).digest('hex').slice(0, 10);
  return `/api/v1/public/branding/${encodeURIComponent(slug)}/logo?v=${v}`;
};

// Update the caller's own tenant branding. `logo_r2_key` is a GCS key from a
// prior /uploads presign+confirm (purpose 'tenant_logo'); we store the key and
// point logo_url at the branding proxy. Pass logo_r2_key=null to clear.
// Other branding fields (brand_name, colors) + fee-receipt config pass through
// if provided.
// Contact/address fields where a blank string means "clear it" — normalise to
// NULL so the receipt header omits the line rather than printing an empty one.
const BLANK_TO_NULL = ['phone', 'website', 'email', 'address_line1', 'address_line2', 'city', 'state', 'pincode'];

export const updateBranding = async (tenant, { logo_r2_key, receipt_terms, ...rest }) => {
  const updates = { ...rest };

  for (const k of BLANK_TO_NULL) {
    if (updates[k] !== undefined) {
      const v = typeof updates[k] === 'string' ? updates[k].trim() : updates[k];
      updates[k] = v || null;
    }
  }

  if (logo_r2_key !== undefined) {
    updates.logo_r2_key = logo_r2_key || null;
    updates.logo_url = logo_r2_key ? proxyLogoUrl(tenant.slug, logo_r2_key) : null;
  }

  // receipt_terms is a jsonb column — serialise the array so node-pg writes
  // JSON, not a Postgres text[] literal.
  if (receipt_terms !== undefined) {
    updates.receipt_terms = JSON.stringify(Array.isArray(receipt_terms) ? receipt_terms : []);
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
