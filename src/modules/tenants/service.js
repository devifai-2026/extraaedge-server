import argon2 from 'argon2';
import * as repo from './repo.js';
import { provisionTenantDatabase } from '../../services/tenant-provisioning.js';
import { conflict, notFound } from '../../lib/errors.js';
import { encrypt, randomToken } from '../../lib/crypto.js';
import { invalidateTenantCache, resolveTenantById, tenantQuery } from '../../db/tenant.js';
import { recordPlatformAudit } from '../../services/platform-audit.js';

const buildDbIdentity = (slug) => {
  const db_name = `tenant_${slug.replace(/-/g, '_')}`;
  const db_user = `tuser_${slug.replace(/-/g, '_')}`;
  // Cloud SQL requires upper+lower+digit+symbol — append guarantees regardless of randomToken's charset.
  const db_password = `Aa1!${randomToken(24)}`;
  return { db_name, db_user, db_password };
};

export const createTenant = async ({ input, platform_user_id, ip, user_agent }) => {
  if (await repo.existsBySlug(input.slug)) throw conflict('slug already in use');
  const { db_name, db_user, db_password } = buildDbIdentity(input.slug);
  if (await repo.existsByDbName(db_name)) throw conflict('generated db_name conflicts with existing tenant');

  const firstAdminPasswordHash = await argon2.hash(input.first_admin.password, {
    type: argon2.argon2id,
    memoryCost: 1 << 16,
    timeCost: 3,
    parallelism: 1,
  });

  const tenant = await repo.runInSystemTx(async (client) => {
    const row = await repo.insert(client, {
      ...input,
      status: 'provisioning',
      db_name,
      db_user,
      db_password_encrypted: encrypt(db_password),
      provisioned_by_platform_user_id: platform_user_id,
    });
    return row;
  });

  // Create DB, run migrations, seed. If this throws, we mark the tenant as cancelled.
  try {
    await provisionTenantDatabase({
      tenant,
      db_password,
      first_admin: {
        name: input.first_admin.name,
        email: input.first_admin.email,
        phone: input.first_admin.phone,
        password_hash: firstAdminPasswordHash,
      },
    });
    await repo.setStatus(tenant.id, 'active');
    await recordPlatformAudit({
      platform_user_id,
      action: 'tenant.created',
      entity_type: 'tenant',
      entity_id: tenant.id,
      tenant_id: tenant.id,
      after_json: { slug: tenant.slug, name: tenant.name },
      ip,
      user_agent,
    });
    invalidateTenantCache(tenant.slug);
    return { ...tenant, status: 'active' };
  } catch (err) {
    await repo.setStatus(tenant.id, 'cancelled');
    throw err;
  }
};

export const listTenants = (query) => repo.list(query);
export const getTenant = async (id) => {
  const row = await repo.findById(id);
  if (!row) throw notFound('Tenant not found');
  return row;
};
export const updateTenant = async (id, updates) => {
  const row = await repo.updateById(id, updates);
  if (!row) throw notFound('Tenant not found');
  invalidateTenantCache(row.slug);
  return row;
};
export const suspendTenant = async (id, platform_user_id, ip, user_agent) => {
  const row = await repo.setStatus(id, 'suspended');
  if (!row) throw notFound('Tenant not found');
  invalidateTenantCache(row.slug);
  await recordPlatformAudit({ platform_user_id, action: 'tenant.suspended', entity_type: 'tenant', entity_id: id, tenant_id: id, ip, user_agent });
  return row;
};
export const resumeTenant = async (id, platform_user_id, ip, user_agent) => {
  const row = await repo.setStatus(id, 'active');
  if (!row) throw notFound('Tenant not found');
  invalidateTenantCache(row.slug);
  await recordPlatformAudit({ platform_user_id, action: 'tenant.resumed', entity_type: 'tenant', entity_id: id, tenant_id: id, ip, user_agent });
  return row;
};

// Soft-delete: marks deleted_at, sets status='suspended'. The tenant_<slug>
// database is intentionally NOT dropped — we keep it for audit / recovery.
// A separate hard-delete flow can be added later if/when admins need it.
export const deleteTenant = async (id, platform_user_id, ip, user_agent) => {
  const row = await repo.softDelete(id);
  if (!row) throw notFound('Tenant not found');
  invalidateTenantCache(row.slug);
  await recordPlatformAudit({ platform_user_id, action: 'tenant.deleted', entity_type: 'tenant', entity_id: id, tenant_id: id, ip, user_agent });
  return row;
};

// Build the tenant's user hierarchy (super_admin → branch_manager →
// sales_manager → counsellor) for the product-owner UI. Returns an array of
// root nodes (users with no manager) so the caller can render multiple
// top-level owners if a tenant has more than one.
//
// Per the product spec, each node carries only `id`, `name`, and `role` —
// no email or other internal data. The product owner sees structure, not
// internals.
export const getOrgTree = async (id) => {
  const tenant = await resolveTenantById(id);
  if (!tenant) throw notFound('Tenant not found');
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, role, manager_id
       FROM users
      WHERE deleted_at IS NULL AND is_active = true
      ORDER BY
        -- Owners first, then branch managers, then sales managers, then
        -- counsellors. Stable secondary sort by name keeps the tree
        -- deterministic.
        CASE role WHEN 'super_admin' THEN 0 WHEN 'branch_manager' THEN 1 WHEN 'sales_manager' THEN 2 ELSE 3 END,
        name`,
  );

  // Build an in-memory tree from the flat list. O(n).
  const byId = new Map();
  const roots = [];
  for (const r of rows) {
    byId.set(r.id, { id: r.id, name: r.name, role: r.role, children: [] });
  }
  for (const r of rows) {
    const node = byId.get(r.id);
    const parent = r.manager_id ? byId.get(r.manager_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
};
