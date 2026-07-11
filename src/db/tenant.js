import pg from 'pg';
import { LRUCache } from 'lru-cache';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { decrypt } from '../lib/crypto.js';
import { sysQuery } from './system.js';
import { tenantNotFound, tenantSuspended } from '../lib/errors.js';

const { Pool } = pg;

// LRU of pg.Pool keyed by tenant_id. Evicting a pool closes it.
const pools = new LRUCache({
  max: env.TENANT_POOL_LRU_MAX,
  dispose: async (pool, tenantId) => {
    try {
      await pool.end();
      logger.debug({ tenantId }, 'tenant pool evicted');
    } catch (err) {
      logger.warn({ tenantId, err: err.message }, 'tenant pool close failed');
    }
  },
});

const tenantMetaCache = new LRUCache({ max: 500, ttl: 5 * 60_000 });

export const resolveTenantBySlug = async (slug) => {
  const cached = tenantMetaCache.get(slug);
  if (cached) return cached;
  const { rows } = await sysQuery(
    `SELECT id, slug, name, company_name, brand_name, status, db_name, db_user, db_password_encrypted, logo_url,
            brand_primary_color, brand_secondary_color, phone, website, email,
            address_line1, address_line2, city, state, pincode,
            receipt_terms, receipt_signatory_label, receipt_thankyou, receipt_no_prefix, receipt_no_start, receipt_no_pad,
            recorder_folder_path, recorder_sync_hour,
            timezone, currency
       FROM tenants
      WHERE slug = $1
        AND deleted_at IS NULL
      LIMIT 1`,
    [slug],
  );
  const tenant = rows[0];
  if (!tenant) throw tenantNotFound();
  tenantMetaCache.set(slug, tenant);
  return tenant;
};

export const resolveTenantById = async (id) => {
  const { rows } = await sysQuery(
    `SELECT id, slug, name, company_name, brand_name, status, db_name, db_user, db_password_encrypted, logo_url,
            brand_primary_color, brand_secondary_color, phone, website, email,
            address_line1, address_line2, city, state, pincode,
            receipt_terms, receipt_signatory_label, receipt_thankyou, receipt_no_prefix, receipt_no_start, receipt_no_pad,
            recorder_folder_path, recorder_sync_hour,
            timezone, currency
       FROM tenants WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
};

export const getTenantPool = async (tenant) => {
  if (!tenant) throw tenantNotFound();
  if (tenant.status !== 'active') throw tenantSuspended();
  const cached = pools.get(tenant.id);
  if (cached) return cached;
  const pool = new Pool({
    host: env.TENANT_DB_HOST,
    port: env.TENANT_DB_PORT,
    database: tenant.db_name,
    user: tenant.db_user,
    password: decrypt(tenant.db_password_encrypted),
    ssl: env.TENANT_DB_SSL ? { rejectUnauthorized: false } : false,
    max: 15,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => logger.error({ tenantId: tenant.id, err: err.message }, 'tenant pg pool error'));
  pools.set(tenant.id, pool);
  return pool;
};

export const tenantQuery = async (tenant, text, params) => {
  const pool = await getTenantPool(tenant);
  return pool.query(text, params);
};

export const tenantTx = async (tenant, fn) => {
  const pool = await getTenantPool(tenant);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

export const invalidateTenantCache = (slug) => tenantMetaCache.delete(slug);

export const closeAllTenantPools = async () => {
  const entries = [...pools.entries()];
  pools.clear();
  await Promise.all(entries.map(async ([, pool]) => pool.end().catch(() => {})));
};
