import { tenantQuery } from '../../db/tenant.js';

// Per-type table metadata.
//   table:        the bare DB table (used by INSERT / UPDATE / soft-delete / reorder).
//   alias:        SELECT-time alias when we need to JOIN. INSERT/UPDATE never use it.
//   selectCols:   columns returned to the client. Already prefixed with the alias.
//   bareCols:     same column list without aliases (used by INSERT…RETURNING).
//   joins:        extra JOIN clauses for SELECT only. Empty string if none.
//
// `bareCols` doubles as the "shape" detector for `hasOrderIndex` etc.
const TABLE_MAP = {
  stages: {
    table: 'lead_stages',
    bareCols: 'id, name, code, order_index, color, is_terminal, is_success, is_active, score, updated_at',
  },
  'sub-stages': {
    table: 'lead_sub_stages',
    alias: 'ss',
    bareCols: 'id, name, stage_id, is_default, order_index, is_active, score, updated_at',
    selectCols:
      'ss.id, ss.name, ss.stage_id, ss.is_default, ss.order_index, ss.is_active, ss.score, ss.updated_at,' +
      ' parent.name AS stage_name, parent.code AS stage_code',
    joins: 'LEFT JOIN lead_stages parent ON parent.id = ss.stage_id',
  },
  channels: { table: 'lead_channels', bareCols: 'id, name, order_index, is_active' },
  sources: { table: 'lead_sources_dict', bareCols: 'id, name, order_index, is_active' },
  campaigns: { table: 'lead_campaigns_dict', bareCols: 'id, name, order_index, is_active' },
  mediums: { table: 'lead_mediums', bareCols: 'id, name, order_index, is_active' },
  'primary-sources': { table: 'lead_primary_sources', bareCols: 'id, name, order_index, is_active' },
  countries: { table: 'countries', bareCols: 'id, name, iso, is_active' },
  // Surface country name on every row so the FE table doesn't show bare UUIDs.
  states: {
    table: 'states',
    alias: 'st',
    bareCols: 'id, name, country_id, is_active',
    selectCols: 'st.id, st.name, st.country_id, st.is_active, c.name AS country_name, c.iso AS country_iso',
    joins: 'LEFT JOIN countries c ON c.id = st.country_id',
  },
  genders: { table: 'genders', bareCols: 'id, name, is_active' },
  degrees: { table: 'degrees', bareCols: 'id, name, level, is_active' },
  specializations: { table: 'specializations', bareCols: 'id, name, is_active' },
  universities: {
    table: 'universities',
    alias: 'u',
    bareCols: 'id, name, country_id, is_active',
    selectCols: 'u.id, u.name, u.country_id, u.is_active, c.name AS country_name, c.iso AS country_iso',
    joins: 'LEFT JOIN countries c ON c.id = u.country_id',
  },
};

const hasOrderIndex = (info) => info && info.bareCols.includes('order_index');

// Pick the right column list / FROM / WHERE prefix for SELECT statements.
const selectShape = (info) => {
  if (info.alias) {
    return {
      cols: info.selectCols || info.bareCols,
      from: `${info.table} ${info.alias} ${info.joins || ''}`,
      // qualify deleted_at + name + order_index by the alias so JOINed rows don't collide
      deletedAt: `${info.alias}.deleted_at`,
      name: `${info.alias}.name`,
      orderIndex: `${info.alias}.order_index`,
    };
  }
  return {
    cols: info.bareCols,
    from: info.table,
    deletedAt: 'deleted_at',
    name: 'name',
    orderIndex: 'order_index',
  };
};

export const getTableForType = (type) => TABLE_MAP[type];

export const listByType = async (tenant, type) => {
  const info = TABLE_MAP[type];
  if (!info) return [];
  const s = selectShape(info);
  const orderBy = hasOrderIndex(info)
    ? `ORDER BY COALESCE(${s.orderIndex}, 0), ${s.name}`
    : `ORDER BY ${s.name}`;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${s.cols} FROM ${s.from} WHERE ${s.deletedAt} IS NULL ${orderBy}`,
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
    `INSERT INTO ${info.table} (${columns.join(',')}) VALUES (${placeholders.join(',')}) RETURNING ${info.bareCols}`,
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
    `UPDATE ${info.table} SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${info.bareCols}`,
    values,
  );
  return rows[0] ?? null;
};

export const remove = async (tenant, type, id) => {
  const info = TABLE_MAP[type];
  await tenantQuery(tenant, `DELETE FROM ${info.table} WHERE id = $1`, [id]);
};

export const reorder = async (tenant, type, orderList) => {
  const info = TABLE_MAP[type];
  if (!hasOrderIndex(info)) return;
  for (const o of orderList) {
    // eslint-disable-next-line no-await-in-loop
    await tenantQuery(tenant, `UPDATE ${info.table} SET order_index = $2 WHERE id = $1`, [o.id, o.order_index]);
  }
};
