import { tenantQuery } from '../../db/tenant.js';

const COLS = `id, name, origins, member_ids, strategy, priority, is_active,
              last_assigned_user_id, last_assigned_at, total_assignments,
              created_at, updated_at`;

export const list = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM lead_routing_pools
      WHERE deleted_at IS NULL
      ORDER BY priority, created_at`,
  );
  return rows;
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM lead_routing_pools WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

// Active pools claiming this origin, best-priority first. `origins @> ARRAY[x]`
// rides the GIN index.
export const findActiveForOrigin = async (tenant, origin) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM lead_routing_pools
      WHERE is_active AND deleted_at IS NULL
        AND origins @> ARRAY[$1]::text[]
      ORDER BY priority, created_at`,
    [origin],
  );
  return rows;
};

export const insert = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO lead_routing_pools (name, origins, member_ids, strategy, priority, is_active)
     VALUES ($1,$2::text[],$3::uuid[],$4,$5,$6)
     RETURNING ${COLS}`,
    [
      input.name,
      input.origins ?? [],
      input.member_ids ?? [],
      input.strategy ?? 'load_balanced',
      input.priority ?? 100,
      input.is_active ?? true,
    ],
  );
  return rows[0];
};

// Only these columns are patchable — the round-robin cursor and the counters
// are owned by the resolver, never by the API.
const UPDATABLE = ['name', 'origins', 'member_ids', 'strategy', 'priority', 'is_active'];

export const update = async (tenant, id, updates) => {
  const fields = [];
  const params = [];
  for (const key of UPDATABLE) {
    if (updates[key] === undefined) continue;
    params.push(updates[key]);
    // origins/member_ids need an explicit array cast for the pg driver.
    const cast = key === 'origins' ? '::text[]' : key === 'member_ids' ? '::uuid[]' : '';
    fields.push(`${key} = $${params.length}${cast}`);
  }
  if (!fields.length) return findById(tenant, id);
  params.push(id);
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE lead_routing_pools SET ${fields.join(', ')}
      WHERE id = $${params.length} AND deleted_at IS NULL
      RETURNING ${COLS}`,
    params,
  );
  return rows[0] ?? null;
};

// Soft delete, matching the convention on assignment_rules / custom_roles.
export const softDelete = async (tenant, id) => {
  await tenantQuery(
    tenant,
    `UPDATE lead_routing_pools SET deleted_at = now(), is_active = false
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
};

export const recordAssignment = async (tenant, id, userId) => {
  await tenantQuery(
    tenant,
    `UPDATE lead_routing_pools
        SET last_assigned_user_id = $2,
            last_assigned_at = now(),
            total_assignments = total_assignments + 1
      WHERE id = $1`,
    [id, userId],
  );
};

// Which pools still list this user? Used to warn on a role switch or
// deactivation — we report, we never strip the id (the resolver already
// ignores ineligible members, and removing it would lose the admin's intent).
export const poolsContainingUser = async (tenant, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, origins, is_active FROM lead_routing_pools
      WHERE deleted_at IS NULL AND member_ids @> ARRAY[$1]::uuid[]
      ORDER BY priority, created_at`,
    [userId],
  );
  return rows;
};
