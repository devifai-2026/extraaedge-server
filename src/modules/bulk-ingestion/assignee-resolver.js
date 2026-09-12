// Resolves a bulk-import row's `assigned_to_email` into `assigned_to` (and
// `manager_id`) following these rules:
//
//   blank / unknown email        → leave assigned_to NULL (global RR catches it
//                                  at end-of-job)
//   COUNSELLOR / TELECALLER      → assign directly, manager_id = their manager_id
//   SALES_MANAGER / BRANCH_MGR / → round-robin across that manager's own
//   TELECALLER_LEAD                front-line reports, manager_id = the manager
//   SUPER_ADMIN                  → round-robin across every front-line user in
//                                  the tenant, excluding the admin themselves,
//                                  with manager_id taken from the picked user.
//
// NOTE: this used to return `team_id` but that's a FK to the `teams` table
// (an actual team entity, only created when teams are configured). The
// hierarchy info we're computing here belongs on `leads.manager_id` (FK to
// users). Sending a user UUID through `team_id` caused FK violations like
// "leads_team_id_fkey violates" and bounced the whole row to failed_leads.
//
// State is per-bulk-import (in-memory): each distinct pool gets its own
// cursor inside one job, so leads land fairly within a single upload.
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES, TEAM_SCOPED_MANAGER_ROLES, LEAD_OWNER_ROLES } from '../../config/constants.js';

export const createAssigneeCache = () => ({
  // email (lowercased) -> { id, role, manager_id } | null (miss)
  userByEmail: new Map(),
  // user_id -> { id, role, manager_id }
  userById: new Map(),
  // manager_id -> [{ id, manager_id }] front-line users reporting to them
  ownersByManager: new Map(),
  // tenant-wide pool for admin assignments: [{ id, role, manager_id }]
  adminPool: null,
  // poolKey -> next index to use
  cursors: new Map(),
});

const lookupUserByEmail = async (tenant, cache, email) => {
  const key = email.trim().toLowerCase();
  if (cache.userByEmail.has(key)) return cache.userByEmail.get(key);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, role, manager_id
       FROM users
      WHERE lower(email) = $1 AND deleted_at IS NULL AND is_active = true
      LIMIT 1`,
    [key],
  );
  const user = rows[0] ?? null;
  cache.userByEmail.set(key, user);
  if (user) cache.userById.set(user.id, user);
  return user;
};

// Front-line users (counsellor / telecaller) reporting directly to this
// manager. A telecaller_lead's reports are telecallers; a sales_manager's are
// counsellors — the same query serves both because it filters on the report's
// role, not the manager's.
// Front-line people a named manager can receive leads on behalf of.
//
// Only the PURE manager tiers reach this — sales_manager and branch_manager,
// which cannot hold a lead themselves. A telecaller_lead named in an import is
// assigned directly (see resolveAssignee), so it never fans out here.
//
// Team leads are excluded from the pool regardless: a lead should land on
// someone who works it, not on another lead who would have to redistribute.
//
// DEPTH: matching only `manager_id = $1` finds DIRECT reports, which is wrong
// the moment an org has a tier in between — on SpeedUp the telecallers report
// to the branch manager rather than to a lead, and a sales manager with a
// telecaller_lead under them would have produced an empty pool and silently
// fallen through to global round-robin. We walk the whole downstream subtree.
const loadOwnersFor = async (tenant, cache, manager_id) => {
  if (cache.ownersByManager.has(manager_id)) return cache.ownersByManager.get(manager_id);
  const roles = LEAD_OWNER_ROLES.filter((r) => !TEAM_SCOPED_MANAGER_ROLES.includes(r));
  const { rows } = await tenantQuery(
    tenant,
    `WITH RECURSIVE team AS (
       SELECT id, manager_id FROM users
        WHERE id = $1 AND deleted_at IS NULL
       UNION
       SELECT d.id, d.manager_id
         FROM team t
         JOIN users d ON d.manager_id = t.id
        WHERE d.deleted_at IS NULL
     )
     SELECT u.id, u.manager_id
       FROM team
       JOIN users u ON u.id = team.id
      WHERE u.id <> $1
        AND u.role = ANY($2)
        AND u.deleted_at IS NULL
        AND u.is_active = true
      ORDER BY u.id`,
    [manager_id, roles],
  );
  cache.ownersByManager.set(manager_id, rows);
  return rows;
};

const pickNext = (cache, poolKey, pool) => {
  if (!pool.length) return null;
  const cursor = cache.cursors.get(poolKey) ?? 0;
  const picked = pool[cursor % pool.length];
  cache.cursors.set(poolKey, cursor + 1);
  return picked;
};

// Public form of the email lookup — same caching as the legacy
// admin/manager/counsellor RR path, but exposed so the worker can use it
// for the strict current_lead_owner_email / previous_lead_owner_email
// paths without duplicating the SQL or cache plumbing.
export const lookupUserByEmailStrict = (tenant, cache, email) =>
  lookupUserByEmail(tenant, cache, String(email ?? ''));

// Returns { assigned_to, manager_id } — either may be null. Never throws on
// unknown email; the caller treats null assigned_to as "leave to global RR".
// `manager_id` is a FK to users(id) — the lead's hierarchy parent — NOT the
// `teams.id` FK on `leads.team_id`. Callers should write this onto
// `leads.manager_id`, not `leads.team_id`.
export const resolveAssignee = async (tenant, cache, assigned_to_email) => {
  if (!assigned_to_email || !String(assigned_to_email).trim()) {
    return { assigned_to: null, manager_id: null };
  }

  const user = await lookupUserByEmail(tenant, cache, String(assigned_to_email));
  if (!user) return { assigned_to: null, manager_id: null };

  // ANY user who can hold a lead — counsellor, telecaller, or telecaller_lead —
  // owns it directly when named in the import. Naming a specific person is an
  // explicit instruction, so we honour it literally rather than treating it as
  // "give this to someone on their team".
  //
  // telecaller_lead is the subtle one: it is in LEAD_OWNER_ROLES *and* in
  // TEAM_SCOPED_MANAGER_ROLES. It is matched HERE, before the manager fan-out
  // below, so a spreadsheet naming a team lead assigns to that lead and does
  // NOT round-robin across their telecallers. Only the pure manager tiers
  // (sales_manager / branch_manager), which cannot hold a lead at all, fan out.
  if (LEAD_OWNER_ROLES.includes(user.role)) {
    return { assigned_to: user.id, manager_id: user.manager_id ?? null };
  }

  // A pure manager tier (sales_manager / branch_manager) can't own a lead, so
  // naming one means "spread these across their team".
  if (TEAM_SCOPED_MANAGER_ROLES.includes(user.role)) {
    const pool = await loadOwnersFor(tenant, cache, user.id);
    const picked = pickNext(cache, `mgr:${user.id}`, pool);
    if (!picked) return { assigned_to: null, manager_id: user.id };
    return { assigned_to: picked.id, manager_id: user.id };
  }

  if (user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    const pool = await loadAdminPool(tenant, cache, user.id);
    const picked = pickNext(cache, `admin:${user.id}`, pool);
    if (!picked) return { assigned_to: null, manager_id: null };
    // Every member of the admin pool is a front-line user, so their own
    // manager_id is always the right hierarchy parent for the lead.
    return { assigned_to: picked.id, manager_id: picked.manager_id ?? null };
  }

  // Unknown role (platform role, custom role without a mapped system role) —
  // treat as no match.
  return { assigned_to: null, manager_id: null };
};
