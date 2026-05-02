import argon2 from 'argon2';
import * as repo from './repo.js';
import * as roleRepo from '../custom-roles/repo.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { tenantQuery } from '../../db/tenant.js';

const HASH_OPTS = { type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1 };

const ensureRoleValid = async (tenant, role, role_id) => {
  if (!role_id) return;
  const role_row = await roleRepo.findById(tenant, role_id);
  if (!role_row) throw notFound('Role not found');
  if (role_row.scope !== role) {
    throw conflict(`role_id scope (${role_row.scope}) does not match role (${role})`);
  }
};

export const listUsers = (tenant, query) => repo.list(tenant, query);

export const getUser = async (tenant, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('User not found');
  return row;
};

export const createUser = async (tenant, input) => {
  if (await repo.findByEmail(tenant, input.email)) throw conflict('Email already in use');
  await ensureRoleValid(tenant, input.role, input.role_id);

  // Auto-link role_id to the matching seed/custom role so login can resolve allowed_tabs.
  // Without this, allowed_tabs is null and the user has no UI access.
  let role_id = input.role_id;
  if (!role_id) {
    const seedRole = await roleRepo.findByName(tenant, input.role);
    if (seedRole) role_id = seedRole.id;
  }

  // super_admin role should default track_work_time=false
  const track_work_time = input.track_work_time ?? (input.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN);
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
    { ...input, role_id, track_work_time, manager_id: primary },
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
  if (updates.role && updates.role_id) {
    await ensureRoleValid(tenant, updates.role, updates.role_id);
  }
  if (updates.email && updates.email !== existing.email) {
    const clash = await repo.findByEmail(tenant, updates.email);
    if (clash) throw conflict('Email already in use');
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
