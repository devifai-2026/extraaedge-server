import * as repo from './repo.js';
import { tenantQuery } from '../../db/tenant.js';
import { notFound, appError } from '../../lib/errors.js';
import { RESPONSE_CODES } from '../../config/constants.js';
import { LEAD_OWNER_ROLES } from '../../config/constants.js';
import { classifyOrigin, originSqlPredicate } from '../../lib/leadOrigin.js';
import { logger } from '../../lib/logger.js';

export const listPools = (tenant) => repo.list(tenant);

export const getPool = async (tenant, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('Routing pool not found');
  return row;
};

// Members must be users who can actually own a lead. We reject rather than
// silently drop, so the admin finds out at save time instead of wondering why
// a name they picked never receives anything.
const assertMembersEligible = async (tenant, member_ids) => {
  if (!member_ids?.length) return;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, role, is_active FROM users
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [member_ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bad = member_ids
    .map((id) => {
      const u = byId.get(id);
      if (!u) return `${id} (no such user)`;
      if (!u.is_active) return `${u.name} (deactivated)`;
      if (!LEAD_OWNER_ROLES.includes(u.role)) return `${u.name} (${u.role} cannot own leads)`;
      return null;
    })
    .filter(Boolean);
  if (bad.length) {
    throw appError({
      status: 400,
      code: RESPONSE_CODES.VALIDATION_FAILED,
      message: `Only active counsellors and telecallers can receive leads — rejected: ${bad.join(', ')}`,
      details: { rejected: bad },
    });
  }
};

export const createPool = async (tenant, input) => {
  await assertMembersEligible(tenant, input.member_ids);
  return repo.insert(tenant, input);
};

export const updatePool = async (tenant, id, updates) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Routing pool not found');
  if (updates.member_ids !== undefined) await assertMembersEligible(tenant, updates.member_ids);
  return repo.update(tenant, id, updates);
};

export const deletePool = async (tenant, id) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Routing pool not found');
  await repo.softDelete(tenant, id);
};

export const poolsForUser = (tenant, userId) => repo.poolsContainingUser(tenant, userId);

// Narrow a pool's declared members to the ones that can receive a lead RIGHT
// NOW, preserving the admin's chosen order (round-robin determinism depends on
// it). member_ids has no FK on purpose — a member who was deactivated or moved
// to a manager role stays listed and is filtered out here instead.
const eligibleMembers = async (tenant, member_ids) => {
  if (!member_ids?.length) return [];
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM users
      WHERE id = ANY($1::uuid[]) AND role = ANY($2)
        AND is_active = true AND deleted_at IS NULL`,
    [member_ids, LEAD_OWNER_ROLES],
  );
  const live = new Set(rows.map((r) => r.id));
  return member_ids.filter((id) => live.has(id));
};

// Fewest leads from THIS origin wins — the same rule the JustDial pool uses,
// generalised from one hardcoded source to any origin predicate. Ties break on
// id so the choice is stable.
const pickLoadBalanced = async (tenant, members, origin) => {
  const pred = originSqlPredicate(origin, 'l');
  const { rows } = await tenantQuery(
    tenant,
    `SELECT u.id
       FROM users u
       LEFT JOIN leads l
         ON l.assigned_to = u.id AND l.deleted_at IS NULL AND ${pred}
      WHERE u.id = ANY($1::uuid[])
      GROUP BY u.id
      ORDER BY count(l.id) ASC, u.id
      LIMIT 1`,
    [members],
  );
  return rows[0]?.id ?? null;
};

// Next member after the cursor. A cursor pointing at someone who has since
// dropped out of the eligible set yields index -1, so the pool restarts at the
// first member rather than stalling. Exported for unit tests — pure.
export const pickRoundRobin = (members, lastAssignedUserId) => {
  const lastIdx = lastAssignedUserId ? members.indexOf(lastAssignedUserId) : -1;
  return members[(lastIdx + 1) % members.length];
};

// THE ENTRY POINT. Given a lead, return { user_id, pool, origin } for the first
// active pool that claims the lead's origin and still has an eligible member —
// or null to mean "no pool applies", which makes the caller fall through to the
// assignment_rules engine exactly as before.
//
// Deliberately returns null (rather than picking someone outside the pool) when
// a pool matches but every member is ineligible: leaking a pool-routed lead to
// the tenant-wide round-robin would defeat the point of configuring the pool.
// The lead stays unassigned and shows up in "auto-assign unassigned".
//
// `restrictPool` mirrors pickTarget's option of the same name: a set of user
// ids the assignment must stay inside (a manager's own team, for a
// manager-created lead). Inbound webhook leads have no actor and pass none.
// An empty intersection means this pool has nobody the caller may assign to,
// so we move on to the next pool rather than escaping the restriction.
export const resolveRoutingPoolAssignee = async (tenant, lead, { restrictPool = null } = {}) => {
  const origin = classifyOrigin(lead);
  if (!origin) return null;

  let pools;
  try {
    pools = await repo.findActiveForOrigin(tenant, origin);
  } catch (err) {
    // A tenant whose DB predates the lead_routing_pools migration must not
    // break lead intake — fall through to the assignment rules.
    logger.warn({ tenantId: tenant.id, err: err.message }, 'routing pool lookup failed');
    return null;
  }
  if (!pools.length) return null;

  const allowed = restrictPool ? new Set(restrictPool) : null;
  for (const pool of pools) {
    // eslint-disable-next-line no-await-in-loop
    let members = await eligibleMembers(tenant, pool.member_ids);
    if (allowed) members = members.filter((id) => allowed.has(id));
    if (!members.length) continue;
    const user_id = pool.strategy === 'round_robin'
      ? pickRoundRobin(members, pool.last_assigned_user_id)
      // eslint-disable-next-line no-await-in-loop
      : await pickLoadBalanced(tenant, members, origin);
    if (user_id) return { user_id, pool, origin };
  }
  return null;
};

export const recordPoolAssignment = (tenant, poolId, userId) =>
  repo.recordAssignment(tenant, poolId, userId);
