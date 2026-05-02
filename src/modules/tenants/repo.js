import { sysQuery, sysTx } from '../../db/system.js';

const SELECT_COLUMNS = `
  id, name, slug, company_name, brand_name, logo_url, logo_dark_url, favicon_url,
  brand_primary_color, brand_secondary_color, email, phone, website, industry,
  country, state, city, address_line1, address_line2, pincode, plan_id, billing_email,
  status, trial_ends_at, subscription_ends_at, timezone, currency, default_language,
  db_name, db_user, ip_allowlist, require_2fa,
  provisioned_by_platform_user_id, created_at, updated_at
`;

export const existsBySlug = async (slug) => {
  const { rows } = await sysQuery('SELECT 1 FROM tenants WHERE slug = $1 LIMIT 1', [slug]);
  return rows.length > 0;
};

export const existsByDbName = async (dbName) => {
  const { rows } = await sysQuery('SELECT 1 FROM tenants WHERE db_name = $1 LIMIT 1', [dbName]);
  return rows.length > 0;
};

export const findById = async (id) => {
  const { rows } = await sysQuery(
    `SELECT ${SELECT_COLUMNS} FROM tenants WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
};

export const findBySlug = async (slug) => {
  const { rows } = await sysQuery(
    `SELECT ${SELECT_COLUMNS} FROM tenants WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
    [slug],
  );
  return rows[0] ?? null;
};

export const insert = async (client, tenant) => {
  const { rows } = await client.query(
    `INSERT INTO tenants (
        name, slug, company_name, brand_name, logo_url, logo_dark_url, favicon_url,
        brand_primary_color, brand_secondary_color, email, phone, website, industry,
        country, state, city, address_line1, address_line2, pincode, plan_id, billing_email,
        status, trial_ends_at, subscription_ends_at, timezone, currency, default_language,
        db_name, db_user, db_password_encrypted, provisioned_by_platform_user_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,$27,$28,$29,$30,$31
      ) RETURNING ${SELECT_COLUMNS}`,
    [
      tenant.name,
      tenant.slug,
      tenant.company_name ?? null,
      tenant.brand_name ?? tenant.company_name ?? tenant.name,
      tenant.logo_url ?? null,
      tenant.logo_dark_url ?? null,
      tenant.favicon_url ?? null,
      tenant.brand_primary_color ?? '#E53935',
      tenant.brand_secondary_color ?? '#C62828',
      tenant.email ?? null,
      tenant.phone ?? null,
      tenant.website ?? null,
      tenant.industry ?? null,
      tenant.country ?? null,
      tenant.state ?? null,
      tenant.city ?? null,
      tenant.address_line1 ?? null,
      tenant.address_line2 ?? null,
      tenant.pincode ?? null,
      tenant.plan_id ?? null,
      tenant.billing_email ?? null,
      tenant.status ?? 'provisioning',
      tenant.trial_ends_at ?? null,
      tenant.subscription_ends_at ?? null,
      tenant.timezone ?? 'Asia/Kolkata',
      tenant.currency ?? 'INR',
      tenant.default_language ?? 'en',
      tenant.db_name,
      tenant.db_user,
      tenant.db_password_encrypted,
      tenant.provisioned_by_platform_user_id ?? null,
    ],
  );
  return rows[0];
};

export const setStatus = async (id, status) => {
  const { rows } = await sysQuery(
    `UPDATE tenants SET status = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING ${SELECT_COLUMNS}`,
    [id, status],
  );
  return rows[0] ?? null;
};

export const updateById = async (id, updates) => {
  const fields = [];
  const values = [];
  let i = 1;
  for (const [k, v] of Object.entries(updates)) {
    fields.push(`${k} = $${i}`);
    values.push(v);
    i += 1;
  }
  if (fields.length === 0) return findById(id);
  values.push(id);
  const { rows } = await sysQuery(
    `UPDATE tenants SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  return rows[0] ?? null;
};

export const list = async ({ q, status, page, limit }) => {
  const conditions = ['deleted_at IS NULL'];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(name ILIKE $${params.length} OR slug ILIKE $${params.length} OR company_name ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const countParams = params.slice(0, -2);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    sysQuery(
      `SELECT ${SELECT_COLUMNS} FROM tenants ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    sysQuery(`SELECT count(*)::int AS total FROM tenants ${where}`, countParams),
  ]);
  return { rows, total: countRows[0].total };
};

export const softDelete = async (id) => {
  await sysQuery(`UPDATE tenants SET deleted_at = now(), status = 'cancelled' WHERE id = $1`, [id]);
};

export const runInSystemTx = sysTx;
