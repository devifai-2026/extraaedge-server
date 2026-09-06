import { tenantQuery } from '../../db/tenant.js';

const COLS = `id, name, origins, source_names, member_ids, strategy, priority, is_active,
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

// Active pools that claim a lead, best-priority first. A pool matches when
// EITHER
//   (a) the lead's derived origin is in `origins`  — the built-in channels, or
//   (b) the lead's own first_touch_source/channel text appears in
//       `source_names` — the tenant's own vocabulary ("Social Media").
//
// (b) is a case-insensitive comparison, so the array is lowercased on both
// sides; that means it can't ride the GIN index, but the active-pool set is a
// handful of rows per tenant and is already narrowed by the is_active partial
// index, so it stays cheap.
//
// `origin` may be null (a lead with no recognisable channel) — such a lead can
// still be claimed through source_names, which is the whole point.
export const findActiveForLead = async (tenant, { origin, source, channel }) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM lead_routing_pools
      WHERE is_active AND deleted_at IS NULL
        AND (
          ($1::text IS NOT NULL AND origins @> ARRAY[$1]::text[])
          OR EXISTS (
            SELECT 1 FROM unnest(source_names) sn
             WHERE lower(sn) = lower($2::text) OR lower(sn) = lower($3::text)
          )
        )
      ORDER BY priority, created_at`,
    [origin ?? null, source ?? null, channel ?? null],
  );
  return rows;
};

export const insert = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO lead_routing_pools (name, origins, source_names, member_ids, strategy, priority, is_active)
     VALUES ($1,$2::text[],$3::text[],$4::uuid[],$5,$6,$7)
     RETURNING ${COLS}`,
    [
      input.name,
      input.origins ?? [],
      input.source_names ?? [],
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
const UPDATABLE = ['name', 'origins', 'source_names', 'member_ids', 'strategy', 'priority', 'is_active'];

export const update = async (tenant, id, updates) => {
  const fields = [];
  const params = [];
  for (const key of UPDATABLE) {
    if (updates[key] === undefined) continue;
    params.push(updates[key]);
    // origins/member_ids need an explicit array cast for the pg driver.
    const cast = (key === 'origins' || key === 'source_names') ? '::text[]' : key === 'member_ids' ? '::uuid[]' : '';
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
    `SELECT id, name, origins, source_names, is_active FROM lead_routing_pools
      WHERE deleted_at IS NULL AND member_ids @> ARRAY[$1]::uuid[]
      ORDER BY priority, created_at`,
    [userId],
  );
  return rows;
};
