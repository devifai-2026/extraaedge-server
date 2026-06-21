// Resolves a bulk-import row's `assigned_to_email` into `assigned_to` (and
// `manager_id`) following these rules:
//
//   blank / unknown email   → leave assigned_to NULL (global RR catches it
//                             at end-of-job)
//   COUNSELLOR               → assign directly, manager_id = counsellor.manager_id
//   SALES_MANAGER            → round-robin across that manager's counsellors,
//                             manager_id = the manager
//   SUPER_ADMIN              → round-robin across all managers + counsellors
//                             in the tenant, excluding the admin themselves.
//                             If the picked user is a counsellor, manager_id is
//                             that counsellor's manager_id; otherwise NULL.
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
import { SYSTEM_TENANT_ROLES, TEAM_SCOPED_MANAGER_ROLES } from '../../config/constants.js';

export const createAssigneeCache = () => ({
  // email (lowercased) -> { id, role, manager_id } | null (miss)
  userByEmail: new Map(),
  // user_id -> { id, role, manager_id }
  userById: new Map(),
  // manager_id -> [{ id, manager_id }] counsellors reporting to them
  counsellorsByManager: new Map(),
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

const loadCounsellorsFor = async (tenant, cache, manager_id) => {
  if (cache.counsellorsByManager.has(manager_id)) return cache.counsellorsByManager.get(manager_id);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, manager_id
       FROM users
      WHERE manager_id = $1
        AND role = $2
        AND deleted_at IS NULL
        AND is_active = true
      ORDER BY id`,
    [manager_id, SYSTEM_TENANT_ROLES.COUNSELLOR],
  );
  cache.counsellorsByManager.set(manager_id, rows);
  return rows;
};

const loadAdminPool = async (tenant, cache, exclude_user_id) => {
  if (cache.adminPool) return cache.adminPool.filter((u) => u.id !== exclude_user_id);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, role, manager_id
       FROM users
      WHERE role IN ($1, $2)
        AND deleted_at IS NULL
        AND is_active = true
      ORDER BY id`,
    [SYSTEM_TENANT_ROLES.SALES_MANAGER, SYSTEM_TENANT_ROLES.COUNSELLOR],
  );
  cache.adminPool = rows;
  return rows.filter((u) => u.id !== exclude_user_id);
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

  if (user.role === SYSTEM_TENANT_ROLES.COUNSELLOR) {
    return { assigned_to: user.id, manager_id: user.manager_id ?? null };
  }

  if (TEAM_SCOPED_MANAGER_ROLES.includes(user.role)) {
    const pool = await loadCounsellorsFor(tenant, cache, user.id);
    const picked = pickNext(cache, `mgr:${user.id}`, pool);
    if (!picked) return { assigned_to: null, manager_id: user.id };
    return { assigned_to: picked.id, manager_id: user.id };
  }

  if (user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    const pool = await loadAdminPool(tenant, cache, user.id);
    const picked = pickNext(cache, `admin:${user.id}`, pool);
    if (!picked) return { assigned_to: null, manager_id: null };
    const manager_id = picked.role === SYSTEM_TENANT_ROLES.COUNSELLOR
      ? (picked.manager_id ?? null)
      : null;
    return { assigned_to: picked.id, manager_id };
  }

  // Unknown role (platform role, custom role without a mapped system role) —
  // treat as no match.
  return { assigned_to: null, manager_id: null };
};
