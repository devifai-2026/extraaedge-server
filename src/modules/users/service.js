import argon2 from 'argon2';
import * as repo from './repo.js';
import * as roleRepo from '../custom-roles/repo.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { tenantQuery } from '../../db/tenant.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';

const HASH_OPTS = { type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1 };

// When the caller passes a role_id, the canonical scope comes from
// custom_roles.scope. We return that scope so the caller can use it as
// the user's `role` bucket — the FE never has to pick a bucket separately
// when assigning a custom role.
const resolveRoleFromRoleId = async (tenant, role_id) => {
  if (!role_id) return null;
  const role_row = await roleRepo.findById(tenant, role_id);
  if (!role_row) throw notFound('Role not found');
  return role_row.scope; // 'super_admin' | 'sales_manager' | 'counsellor'
};

export const listUsers = (tenant, query) => repo.list(tenant, query);

export const getUser = async (tenant, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('User not found');
  return row;
};

export const createUser = async (tenant, input, actor) => {
  if (await repo.findByEmail(tenant, input.email)) throw conflict('Email already in use');

  // If a role_id was supplied, the canonical bucket is custom_roles.scope.
  // Derive `role` from it so the FE can submit just role_id when the admin
  // picks a custom role from the dropdown.
  let role = input.role;
  let role_id = input.role_id;
  if (role_id) {
    const scope = await resolveRoleFromRoleId(tenant, role_id);
    if (scope) role = scope;
  } else {
    // No role_id — auto-link to the matching seed role for the bucket.
    // Without this, allowed_tabs would be null and the user would have no UI access.
    const seedRole = await roleRepo.findByName(tenant, role);
    if (seedRole) role_id = seedRole.id;
  }

  // Only the tenant super_admin can create users in the account_manager
  // role. Other elevated roles (sales_manager) can manage their team but
  // not provision org-level account managers.
  if (role === SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER
      && actor?.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    throw forbidden('Only the tenant admin can create account-manager users');
  }

  // account_manager has no team / no reporting manager — these don't apply
  // even if the caller accidentally sends them. Strip silently so the FE
  // doesn't have to special-case the payload shape.
  if (role === SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER) {
    input = { ...input, manager_id: null, manager_ids: [], team_id: null };
  }

  // super_admin role should default track_work_time=false
  const track_work_time = input.track_work_time ?? (role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN);
  const password_hash = await argon2.hash(input.password, HASH_OPTS);

  // Manager handling: prefer manager_ids[] if provided. The first id becomes
  // the primary `manager_id` (used by lead-scope hierarchy), the rest go into
  // the user_managers join table.
  const ids = Array.isArray(input.manager_ids) && input.manager_ids.length
    ? input.manager_ids
    : (input.manager_id ? [input.manager_id] : []);
  const primary = ids[0] ?? null;

  const user = await repo.insert(
    tenant,
    { ...input, role, role_id, track_work_time, manager_id: primary },
    password_hash,
  );
  if (ids.length) await repo.setManagers(tenant, user.id, ids);
  return user;
};

export const updateUser = async (tenant, id, updates, actor) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('User not found');
  // A super_admin cannot be demoted by a non-self actor if they're the last super_admin — caller should check.
  if (updates.role && updates.role !== existing.role && existing.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    // Safety: don't let the last super_admin demote themselves.
    const others = await repo.list(tenant, { role: SYSTEM_TENANT_ROLES.SUPER_ADMIN, is_active: 'true', page: 1, limit: 2 });
    if (others.total <= 1) throw forbidden('Cannot demote the last super_admin');
  }
  // If role_id is being updated, derive the role bucket from the
  // custom_role's scope (same logic as createUser). Admin only sends
  // role_id; we figure out the bucket.
  if (updates.role_id) {
    const scope = await resolveRoleFromRoleId(tenant, updates.role_id);
    if (scope) updates = { ...updates, role: scope };
  }
  if (updates.email && updates.email.toLowerCase() !== (existing.email ?? '').toLowerCase()) {
    const clash = await repo.findByEmail(tenant, updates.email);
    if (clash && clash.id !== id) throw conflict('Email already in use');
  }

  // Same gate as createUser: changing a user's role TO account_manager
  // requires super_admin. Existing account_managers can still be edited
  // by other admins, just not promoted INTO the role.
  if (updates.role === SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER
      && existing.role !== SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER
      && actor?.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    throw forbidden('Only the tenant admin can promote a user to account_manager');
  }
  // account_manager has no team / no manager — null them if the caller
  // didn't explicitly clear them.
  if (updates.role === SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER) {
    updates = { ...updates, manager_id: null, manager_ids: [], team_id: null };
  }
  // Don't let the last active super_admin deactivate themselves — would lock
  // everybody out. Same logic as the demote / delete guards above.
  if (updates.is_active === false && existing.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN && existing.is_active) {
    const others = await repo.list(tenant, { role: SYSTEM_TENANT_ROLES.SUPER_ADMIN, is_active: 'true', page: 1, limit: 2 });
    if (others.total <= 1) throw forbidden('Cannot deactivate the last super_admin');
  }

  // Sync manager_ids[] to join table; mirror first into manager_id.
  let patch = { ...updates };
  if (Array.isArray(updates.manager_ids)) {
    patch.manager_id = updates.manager_ids[0] ?? null;
    delete patch.manager_ids;
    await repo.setManagers(tenant, id, updates.manager_ids);
  }
  return repo.update(tenant, id, patch);
};

export const deleteUser = async (tenant, id, actor) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('User not found');
  if (existing.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    const others = await repo.list(tenant, { role: SYSTEM_TENANT_ROLES.SUPER_ADMIN, is_active: 'true', page: 1, limit: 2 });
    if (others.total <= 1) throw forbidden('Cannot delete the last super_admin');
  }
  if (actor?.id === id) throw forbidden('Cannot delete yourself');
  await repo.softDelete(tenant, id);
};

export const resetPassword = async (tenant, id, new_password) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('User not found');
  const hash = await argon2.hash(new_password, HASH_OPTS);
  await repo.updatePasswordHash(tenant, id, hash);
};

export const updatePermissions = async (tenant, id, permissions_json) =>
  repo.update(tenant, id, { permissions_json });

export const myTeam = async (tenant, actor_id) => {
  const ids = await repo.teamHierarchy(tenant, actor_id);
  return repo.teamUsers(tenant, ids);
};

export const userLeads = async (tenant, userId, { status, limit }) => {
  return repo.userLeads(tenant, userId, { status, limit });
};

export const userWorkSessions = async (tenant, userId, { days }) => {
  return repo.userWorkSessions(tenant, userId, { days });
};

export const userLoginEvents = async (tenant, userId, { days }) => {
  return repo.userLoginEvents(tenant, userId, { days });
};

export const updatedAtLoader = (tenant) => async (req) => repo.getUpdatedAt(tenant, req.params.id);

// Org tree data for the canvas. Returns a flat list — the FE positions
// nodes by role tier (super_admin → manager → counsellor) and draws edges
// from the user_managers join table (multi-manager) plus the legacy
// users.manager_id (kept in sync as the primary).
//
// Scope:
//   super_admin   → every active user in the tenant
//   sales_manager → full chain they're part of (their managers above + team
//                   below, recursive). Counsellors only see themselves so
//                   we don't expose this route to them at the route layer.
export const orgTree = async (tenant, actor) => {
  const isAdmin = actor.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN;

  let userIds;
  if (isAdmin) {
    const { rows } = await tenantQuery(
      tenant,
      `SELECT id FROM users WHERE deleted_at IS NULL AND is_active = true`,
    );
    userIds = rows.map((r) => r.id);
  } else {
    // Manager scope: union of (a) downstream team via teamHierarchy and
    // (b) upstream chain via recursive walk through user_managers + legacy
    // users.manager_id. We also pull every super_admin so the org chart
    // shows the top of the tree even if the manager doesn't directly
    // report to one.
    const team = await repo.teamHierarchy(tenant, actor.id);
    const { rows: chainRows } = await tenantQuery(
      tenant,
      `WITH RECURSIVE chain AS (
         SELECT id, manager_id FROM users WHERE id = $1 AND deleted_at IS NULL
         UNION
         SELECT u.id, u.manager_id
           FROM users u
           JOIN chain c ON u.id = c.manager_id
          WHERE u.deleted_at IS NULL
         UNION
         SELECT um_target.id, um_target.manager_id
           FROM user_managers um
           JOIN users um_target ON um_target.id = um.manager_id
           JOIN chain c ON um.user_id = c.id
          WHERE um_target.deleted_at IS NULL
       )
       SELECT id FROM chain`,
      [actor.id],
    );
    const { rows: admins } = await tenantQuery(
      tenant,
      `SELECT id FROM users WHERE role = $1 AND deleted_at IS NULL AND is_active = true`,
      [SYSTEM_TENANT_ROLES.SUPER_ADMIN],
    );
    const set = new Set([
      ...team,
      ...chainRows.map((r) => r.id),
      ...admins.map((a) => a.id),
      actor.id,
    ]);
    userIds = Array.from(set);
  }

  if (!userIds.length) return { nodes: [], edges: [] };

  const { rows: nodes } = await tenantQuery(
    tenant,
    `SELECT id, name, email, role, designation, manager_id, is_active
       FROM users
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
      ORDER BY role DESC, name`,
    [userIds],
  );

  // Edges: pull every (user_id, manager_id) where both endpoints are in
  // the visible set. user_managers is the source of truth for multi-manager;
  // legacy users.manager_id duplicates the primary entry but we still UNION
  // it so users without a user_managers row don't lose their parent.
  const { rows: edges } = await tenantQuery(
    tenant,
    `SELECT user_id, manager_id FROM user_managers
       WHERE user_id = ANY($1::uuid[]) AND manager_id = ANY($1::uuid[])
     UNION
     SELECT id AS user_id, manager_id FROM users
       WHERE id = ANY($1::uuid[]) AND manager_id IS NOT NULL
         AND manager_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [userIds],
  );

  return { nodes, edges };
};

// Persist the current user's avatar object key (GCS). Pass null to clear.
// Returns the new key + a short-lived signed URL so the FE can swap the
// nav-bar avatar without a re-fetch.
export const updateMyAvatar = async (tenant, actor, body) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE users SET avatar_r2_key = $2, updated_at = now()
       WHERE id = $1
   RETURNING avatar_r2_key`,
    [actor.id, body.avatar_r2_key ?? null],
  );
  const updated = rows[0] ?? { avatar_r2_key: null };
  let avatar_url = null;
  if (updated.avatar_r2_key) {
    try {
      avatar_url = await getDownloadSignedUrl({ key: updated.avatar_r2_key });
    } catch {
      // Signed URL is best-effort; clients can fall back to the initials avatar
      // if it ever fails to generate.
    }
  }
  return { avatar_r2_key: updated.avatar_r2_key, avatar_url };
};

// Persist a user's chosen theme. Any field omitted leaves the existing
// value alone; explicit nulls reset that field back to "use system default".
// Returns the updated theme so the FE can confirm without a re-fetch.
export const updateMyTheme = async (tenant, actor, body) => {
  const sets = [];
  const params = [actor.id];
  let i = 2;
  for (const col of ['theme_preset', 'theme_primary', 'theme_primary_dark', 'theme_primary_light']) {
    if (Object.prototype.hasOwnProperty.call(body, col)) {
      sets.push(`${col} = $${i}`);
      params.push(body[col]);
      i += 1;
    }
  }
  if (!sets.length) {
    // Nothing to write; return whatever's stored so the FE stays in sync.
    const { rows } = await tenantQuery(
      tenant,
      `SELECT theme_preset, theme_primary, theme_primary_dark, theme_primary_light
         FROM users WHERE id = $1`,
      [actor.id],
    );
    return rows[0] ?? null;
  }
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE users SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1
   RETURNING theme_preset, theme_primary, theme_primary_dark, theme_primary_light`,
    params,
  );
  return rows[0] ?? null;
};
