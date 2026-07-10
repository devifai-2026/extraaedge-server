import { resolveTenantBySlug, getTenantPool } from '../db/tenant.js';
import { env } from '../config/env.js';
import { tenantNotFound } from '../lib/errors.js';

// Resolve tenant from:
//   1) req.user.tenantSlug (JWT)          — most trusted
//   2) Host subdomain (speedup.productivo.in)
//   3) X-Tenant-Slug header (dev / API tools)
const extractSlug = (req) => {
  if (req.user?.tenantSlug) return req.user.tenantSlug;
  // LMS student principal carries its tenant slug the same way.
  if (req.student?.tenantSlug) return req.student.tenantSlug;
  const host = req.headers.host || '';
  const suffix = `.${env.PUBLIC_TENANT_DOMAIN}`;
  if (host.endsWith(suffix) && host.length > suffix.length) {
    return host.slice(0, -suffix.length);
  }
  const header = req.headers['x-tenant-slug'];
  return typeof header === 'string' && header.length > 0 ? header : null;
};

export const tenantRequired = async (req, _res, next) => {
  try {
    const slug = extractSlug(req);
    if (!slug) throw tenantNotFound();
    const tenant = await resolveTenantBySlug(slug);
    req.tenant = tenant;
    req.db = await getTenantPool(tenant);
    next();
  } catch (err) {
    next(err);
  }
};

// Optional variant — attaches req.tenant + req.db when resolvable, else continues.
// Useful for public endpoints that can optionally be tenant-scoped (e.g., public inbound webhooks).
export const tenantOptional = async (req, _res, next) => {
  const slug = extractSlug(req);
  if (!slug) return next();
  try {
    const tenant = await resolveTenantBySlug(slug);
    req.tenant = tenant;
    req.db = await getTenantPool(tenant);
    next();
  } catch {
    next();
  }
};
