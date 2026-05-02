import { tenantQuery } from '../../db/tenant.js';

const TABLE_MAP = {
  stages: { table: 'lead_stages', cols: 'id, name, code, order_index, color, is_terminal, is_active' },
  'sub-stages': { table: 'lead_sub_stages', cols: 'id, name, stage_id, is_default, order_index, is_active' },
  channels: { table: 'lead_channels', cols: 'id, name, order_index, is_active' },
  sources: { table: 'lead_sources_dict', cols: 'id, name, order_index, is_active' },
  campaigns: { table: 'lead_campaigns_dict', cols: 'id, name, order_index, is_active' },
  mediums: { table: 'lead_mediums', cols: 'id, name, order_index, is_active' },
  countries: { table: 'countries', cols: 'id, name, iso, is_active' },
  states: { table: 'states', cols: 'id, name, country_id, is_active' },
  genders: { table: 'genders', cols: 'id, name, is_active' },
  degrees: { table: 'degrees', cols: 'id, name, level, is_active' },
  specializations: { table: 'specializations', cols: 'id, name, is_active' },
  universities: { table: 'universities', cols: 'id, name, country_id, is_active' },
};

export const getTableForType = (type) => TABLE_MAP[type];

export const listByType = async (tenant, type) => {
  const info = TABLE_MAP[type];
  if (!info) return [];
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${info.cols} FROM ${info.table} WHERE deleted_at IS NULL ORDER BY COALESCE(order_index, 0), name`,
  );
  return rows;
};

export const insert = async (tenant, type, input) => {
  const info = TABLE_MAP[type];
  const columns = [];
  const placeholders = [];
  const values = [];
  let i = 1;
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    columns.push(k);
    placeholders.push(`$${i}`);
    values.push(v);
    i += 1;
  }
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO ${info.table} (${columns.join(',')}) VALUES (${placeholders.join(',')}) RETURNING ${info.cols}`,
    values,
  );
  return rows[0];
};

export const update = async (tenant, type, id, updates) => {
  const info = TABLE_MAP[type];
  const fields = [];
  const values = [];
  let i = 1;
  for (const [k, v] of Object.entries(updates)) {
    fields.push(`${k} = $${i}`);
    values.push(v);
    i += 1;
  }
  if (!fields.length) return null;
  values.push(id);
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE ${info.table} SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${info.cols}`,
    values,
  );
  return rows[0] ?? null;
};

export const remove = async (tenant, type, id) => {
  const info = TABLE_MAP[type];
  await tenantQuery(tenant, `UPDATE ${info.table} SET deleted_at = now() WHERE id = $1`, [id]);
};

export const reorder = async (tenant, type, orderList) => {
  const info = TABLE_MAP[type];
  if (!info.cols.includes('order_index')) return;
  for (const o of orderList) {
    // eslint-disable-next-line no-await-in-loop
    await tenantQuery(tenant, `UPDATE ${info.table} SET order_index = $2 WHERE id = $1`, [o.id, o.order_index]);
  }
};
