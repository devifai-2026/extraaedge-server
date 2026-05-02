// Generic query helpers used by repos to cut boilerplate.
// Both system and tenant pools follow the same `(sql, params) => Promise<{ rows }>` shape,
// so callers pass the `runner` function (e.g. `sysQuery` or `tenantQuery.bind(null, tenant)`).
//
// These helpers are intentionally small and unopinionated — they don't try to hide SQL,
// they just remove repetitive `rows[0]`, pagination math, and dynamic UPDATE SET handling.

/**
 * Run a SELECT and return the first row (or null).
 * @param {(sql: string, params?: any[]) => Promise<{rows: any[]}>} runner
 * @param {string} sql
 * @param {any[]=} params
 */
export const selectOne = async (runner, sql, params) => {
  const { rows } = await runner(sql, params);
  return rows[0] ?? null;
};

/**
 * Run a SELECT and return all rows.
 */
export const selectMany = async (runner, sql, params) => {
  const { rows } = await runner(sql, params);
  return rows;
};

/**
 * Run a COUNT(*) query and return the integer.
 * @returns {Promise<number>}
 */
export const selectCount = async (runner, sql, params) => {
  const { rows } = await runner(sql, params);
  return Number(rows[0]?.count ?? 0);
};

/**
 * Build a parameterized INSERT from a plain object.
 * Skips keys whose value is undefined.
 * @returns {{ rows: any[] }}
 */
export const insertRow = async (runner, table, data, returning = '*') => {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw new Error('insertRow: no columns to insert');
  const cols = entries.map(([k]) => `"${k}"`).join(', ');
  const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
  const values = entries.map(([, v]) => v);
  const { rows } = await runner(
    `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING ${returning}`,
    values,
  );
  return rows[0];
};

/**
 * Build a parameterized UPDATE from a plain object.
 * Skips keys whose value is undefined.
 * Returns the updated row, or null if no rows matched.
 */
export const updateRow = async (runner, table, id, updates, options = {}) => {
  const { idColumn = 'id', extraWhere = '', returning = '*' } = options;
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return null;
  const sets = entries.map(([k], i) => `"${k}" = $${i + 1}`).join(', ');
  const values = entries.map(([, v]) => v);
  values.push(id);
  const where = `${idColumn} = $${values.length}${extraWhere ? ` AND ${extraWhere}` : ''}`;
  const { rows } = await runner(
    `UPDATE ${table} SET ${sets} WHERE ${where} RETURNING ${returning}`,
    values,
  );
  return rows[0] ?? null;
};

/**
 * Soft-delete (UPDATE deleted_at = now()).
 */
export const softDelete = async (runner, table, id, idColumn = 'id') => {
  await runner(`UPDATE ${table} SET deleted_at = now() WHERE ${idColumn} = $1`, [id]);
};

/**
 * Hard-delete a row. Use sparingly — prefer soft-delete.
 */
export const hardDelete = async (runner, table, id, idColumn = 'id') => {
  await runner(`DELETE FROM ${table} WHERE ${idColumn} = $1`, [id]);
};

/**
 * Build pagination clause and offset for a paginated list query.
 * Returns the limit/offset values to splice into your params + the LIMIT/OFFSET SQL fragment.
 *
 * Example:
 *   const { limitClause, params: pageParams } = buildPagination(req.query.page, req.query.limit);
 *   const params = [...whereParams, ...pageParams];
 *   const sql = `SELECT ... ${limitClause}`;
 */
export const buildPagination = (page = 1, limit = 50, paramOffset = 0) => {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;
  const limitIdx = paramOffset + 1;
  const offsetIdx = paramOffset + 2;
  return {
    limit: safeLimit,
    offset,
    page: safePage,
    limitClause: `LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params: [safeLimit, offset],
  };
};

/**
 * Build a WHERE clause incrementally — use inside a repo to translate a
 * filter object into SQL conditions + params.
 *
 * Example:
 *   const wb = whereBuilder();
 *   wb.add(filter.status, (v, i) => `status = $${i}`);
 *   wb.add(filter.q, (v, i) => `(name ILIKE $${i} OR email ILIKE $${i})`, (v) => `%${v}%`);
 *   const sql = `SELECT * FROM x ${wb.sql} ORDER BY ...`;
 *   const { rows } = await runner(sql, [...wb.params, ...pagination.params]);
 */
export const whereBuilder = (initialClauses = []) => {
  const clauses = [...initialClauses];
  const params = [];
  return {
    /**
     * @param {*} value     The filter value. If null/undefined/'', skipped.
     * @param {(value: any, paramIndex: number) => string} build  Builds the SQL fragment with the $N placeholder.
     * @param {(value: any) => any=} transform  Optional value transformer (e.g. wrap with %).
     */
    add(value, build, transform) {
      if (value === undefined || value === null || value === '') return;
      params.push(transform ? transform(value) : value);
      clauses.push(build(value, params.length));
    },
    /** Raw clause without a parameter. */
    addRaw(clause) {
      if (clause) clauses.push(clause);
    },
    get sql() {
      return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    },
    get params() {
      return params;
    },
    get hasFilters() {
      return clauses.length > 0;
    },
  };
};
