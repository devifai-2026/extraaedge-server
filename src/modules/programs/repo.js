import { tenantQuery } from '../../db/tenant.js';

const COLS = `
  id, name, code, description, category, type, price, currency, discount_price,
  duration_value, duration_unit, eligibility, intake_month, country,
  is_active, is_featured, brochure_url, image_url,
  course_fees, registration_amount, payment_mode, fee_installments,
  created_at, updated_at
`;

// Columns that should be written as jsonb (need JSON.stringify + ::jsonb
// cast in the placeholder). Only fee_installments today; the helper
// keeps insert/update generic in case more land later.
const JSONB_COLS = new Set(['fee_installments']);

const renderValue = (col, v) => (JSONB_COLS.has(col) ? JSON.stringify(v) : v);
const renderPlaceholder = (col, i) => (JSONB_COLS.has(col) ? `$${i}::jsonb` : `$${i}`);

export const list = async (tenant, { q, category, is_active, is_featured, page, limit }) => {
  const conds = ['deleted_at IS NULL'];
  const params = [];
  if (category) { params.push(category); conds.push(`category = $${params.length}`); }
  if (is_active === 'true') conds.push('is_active = true');
  if (is_active === 'false') conds.push('is_active = false');
  if (is_featured === 'true') conds.push('is_featured = true');
  if (q) { params.push(`%${q}%`); conds.push(`(name ILIKE $${params.length} OR code ILIKE $${params.length} OR description ILIKE $${params.length})`); }
  const where = `WHERE ${conds.join(' AND ')}`;
  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const countParams = params.slice(0, -2);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    tenantQuery(tenant, `SELECT ${COLS} FROM programs ${where} ORDER BY is_featured DESC, name LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
    tenantQuery(tenant, `SELECT count(*)::int AS total FROM programs ${where}`, countParams),
  ]);
  return { rows, total: countRows[0].total };
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT ${COLS} FROM programs WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
};

export const insert = async (tenant, input) => {
  const cols = Object.keys(input);
  const vals = cols.map((c) => renderValue(c, input[c]));
  const placeholders = cols.map((c, i) => renderPlaceholder(c, i + 1));
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO programs (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING ${COLS}`,
    vals,
  );
  return rows[0];
};

export const update = async (tenant, id, updates) => {
  const fields = [];
  const params = [];
  let i = 1;
  for (const [k, v] of Object.entries(updates)) {
    fields.push(`${k} = ${renderPlaceholder(k, i)}`);
    params.push(renderValue(k, v));
    i += 1;
  }
  if (!fields.length) return findById(tenant, id);
  params.push(id);
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE programs SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${COLS}`,
    params,
  );
  return rows[0] ?? null;
};

export const softDelete = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE programs SET deleted_at = now() WHERE id = $1`, [id]);
};

export const getUpdatedAt = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT updated_at FROM programs WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0]?.updated_at ?? null;
};
