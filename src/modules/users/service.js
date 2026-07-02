import argon2 from 'argon2';
import * as repo from './repo.js';
import * as roleRepo from '../custom-roles/repo.js';
import * as phoneDirectory from './phone-directory.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, TEAM_SCOPED_MANAGER_ROLES } from '../../config/constants.js';
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

// Roles a branch_manager is NOT allowed to create, promote into, or edit.
// They run a branch; they don't mint other admins/branch heads.
const BRANCH_MANAGER_FORBIDDEN_ROLES = [
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
];

// The tenant's primary super_admin id — a branch_manager always reports up to
// the admin (the top of the tree), so we default their manager to it. Returns
// null only if a tenant somehow has no active super_admin (shouldn't happen).
const primarySuperAdminId = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM users
      WHERE role = $1 AND deleted_at IS NULL AND is_active = true
      ORDER BY created_at
      LIMIT 1`,
    [SYSTEM_TENANT_ROLES.SUPER_ADMIN],
  );
  return rows[0]?.id ?? null;
};

// A branch_manager reports to the tenant admin, period — there's no manager to
// pick. Force manager_id to the super_admin and clear any multi-manager list
// the FE may have sent. Returns the patched input/updates object.
const forceBranchManagerReporting = async (tenant, role, obj) => {
  if (role !== SYSTEM_TENANT_ROLES.BRANCH_MANAGER) return obj;
  const adminId = await primarySuperAdminId(tenant);
  return { ...obj, manager_id: adminId, manager_ids: adminId ? [adminId] : [] };
};

// Validate a branch_id references a live branch in this tenant. Throws if not.
const assertBranchExists = async (tenant, branch_id) => {
  if (!branch_id) return;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT 1 FROM branches WHERE id = $1 AND deleted_at IS NULL`,
    [branch_id],
  );
  if (!rows[0]) throw validationError({ branch_id: 'Branch not found' });
};

// Resolve + enforce the branch_id for a user given their (resulting) role.
//   - super_admin   → spans all branches → branch_id forced to null.
//   - branch_manager→ branch is set when they're made a branch head, so a
//                     null branch_id here is allowed (the head-assignment step
//                     fills it). A provided branch_id is honored + validated.
//   - everyone else → branch_id REQUIRED and must be a live branch. If a
//                     branch_manager actor creates them without one, default to
//                     the actor's own branch.
// Returns the patched obj with a normalized branch_id.
const resolveBranchForRole = async (tenant, role, actor, obj) => {
  if (role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    return { ...obj, branch_id: null };
  }
  let branch_id = obj.branch_id ?? null;
  // Default a branch_manager-actor's new reports into the actor's own branch.
  if (!branch_id && actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER && actor.branch_id) {
    branch_id = actor.branch_id;
  }
  if (role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER) {
    await assertBranchExists(tenant, branch_id);
    return { ...obj, branch_id };
  }
  // sales_manager / counsellor / account_manager: branch required.
  if (!branch_id) throw validationError({ branch_id: 'A branch is required' });
  await assertBranchExists(tenant, branch_id);
  return { ...obj, branch_id };
};

// Whether the tenant has any branch yet. Before the first branch exists we
// can't enforce branch assignment (the admin hasn't run onboarding) — so
// enforcement is skipped until at least one branch is created.
const tenantHasBranches = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT 1 FROM branches WHERE deleted_at IS NULL LIMIT 1`,
  );
  return Boolean(rows[0]);
};

// Constrain what a branch_manager actor may do to a target user. super_admin
// is unrestricted. Branch managers:
//   - may only create/edit users that fall inside their own branch (their
//     downstream team subtree, resolved from users.manager_id), and
//   - may not create, promote into, or touch super_admin / branch_manager
//     users.
// `targetRole` is the resulting role bucket; `targetUserId` is the user being
// edited (null on create); `managerId` is the new/edited user's primary
// reporting manager. Throws forbidden on violation; resolves to void otherwise.
const assertBranchManagerScope = async (tenant, actor, { targetRole, targetUserId, managerId }) => {
  if (!actor || actor.role !== SYSTEM_TENANT_ROLES.BRANCH_MANAGER) return;
  if (targetRole && BRANCH_MANAGER_FORBIDDEN_ROLES.includes(targetRole)) {
    throw forbidden('Branch managers cannot manage admin or branch-manager accounts');
  }
  const branch = await repo.teamHierarchy(tenant, actor.id); // includes actor + subtree
  const inBranch = (id) => id && branch.includes(id);
  // On edit, the existing user must already be inside the branch.
  if (targetUserId && !inBranch(targetUserId)) {
    throw forbidden('User is outside your branch');
  }
  // The (new) reporting manager must be the branch manager themselves or
  // someone already inside the branch — otherwise the user would be parented
  // into another branch.
  if (managerId && !inBranch(managerId)) {
    throw forbidden('Reporting manager must be inside your branch');
  }
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

  // account_manager users can be provisioned by the tenant super_admin OR by
  // a branch_manager (so a branch can be staffed end-to-end). sales_manager
  // and below still cannot mint account managers.
  if (role === SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER
      && actor?.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN
      && actor?.role !== SYSTEM_TENANT_ROLES.BRANCH_MANAGER) {
    throw forbidden('Only an admin or branch manager can create account-manager users');
  }

  // account_manager has no team beneath them, but they DO report to a branch
  // manager (or the tenant super_admin) now that the org is branch-wise — so
  // we keep their manager_id and only strip team_id. Their lead visibility
  // stays converted-only regardless (see leads/service.js computeScope).
  if (role === SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER) {
    input = { ...input, team_id: null };
  }

  // A branch_manager always reports to the tenant admin — force it and ignore
  // any manager the FE sent (the FE disables the "Reporting To" picker for
  // this role). Keeps the branch tree rooted at the admin.
  input = await forceBranchManagerReporting(tenant, role, input);

  // Branch assignment: required for non-super_admin once the tenant has any
  // branch (i.e. after onboarding). Before the first branch exists we skip the
  // requirement so the admin can still manage users pre-setup.
  if (role === SYSTEM_TENANT_ROLES.SUPER_ADMIN || await tenantHasBranches(tenant)) {
    input = await resolveBranchForRole(tenant, role, actor, input);
  }

  // When a branch_manager creates a user without specifying a reporting
  // manager, default it to the branch_manager themselves so the new user
  // lands inside their branch (never an orphan outside any branch). Doesn't
  // apply to account_manager, whose manager_id may legitimately be set
  // separately to the branch head.
  if (actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER
      && !(Array.isArray(input.manager_ids) && input.manager_ids.length)
      && !input.manager_id) {
    input = { ...input, manager_id: actor.id };
  }

  // Branch managers may only create users inside their own branch and may not
  // create admins / other branch managers.
  await assertBranchManagerScope(tenant, actor, {
    targetRole: role,
    targetUserId: null,
    managerId: input.manager_ids?.[0] ?? input.manager_id ?? null,
  });

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

  // Register the phone platform-wide (system DB). In enforced mode a collision
  // throws 409; we roll back the just-created user so we don't leave an
  // unregistered orphan. In soft mode this never throws.
  if (input.phone) {
    try {
      await phoneDirectory.claimPhone({ phone: input.phone, tenantId: tenant.id, userId: user.id });
    } catch (err) {
      await repo.softDelete(tenant, user.id).catch(() => {});
      throw err;
    }
  }
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

  // Same gate as createUser: promoting a user TO account_manager requires
  // super_admin or branch_manager. Existing account_managers can still be
  // edited by other admins, just not promoted INTO the role by lower tiers.
  if (updates.role === SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER
      && existing.role !== SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER
      && actor?.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN
      && actor?.role !== SYSTEM_TENANT_ROLES.BRANCH_MANAGER) {
    throw forbidden('Only an admin or branch manager can promote a user to account_manager');
  }
  // account_manager has no team beneath them, but DOES report to a branch
  // manager now — keep manager_id, only null team_id.
  if (updates.role === SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER) {
    updates = { ...updates, team_id: null };
  }
  // If the user is (or is becoming) a branch_manager, force their reporting up
  // to the tenant admin and ignore any manager the FE sent. Only applies when
  // the role is actually changing to / staying branch_manager AND the caller
  // touched the role or manager fields, so we don't clobber on unrelated edits.
  const effectiveRole = updates.role ?? existing.role;
  if (effectiveRole === SYSTEM_TENANT_ROLES.BRANCH_MANAGER
      && ('role' in updates || 'manager_id' in updates || 'manager_ids' in updates)) {
    updates = await forceBranchManagerReporting(tenant, effectiveRole, updates);
  }
  // Branch assignment enforcement, mirroring createUser. Only evaluated when
  // the role is changing or branch_id is being touched, so unrelated edits
  // (e.g. a name change) never trip the requirement. super_admin is forced to
  // a null branch. For other roles, resolve against the new-or-existing
  // branch_id and require one (once the tenant has branches).
  if ('role' in updates || 'branch_id' in updates) {
    if (effectiveRole === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
      updates = { ...updates, branch_id: null };
    } else if (await tenantHasBranches(tenant)) {
      const merged = await resolveBranchForRole(tenant, effectiveRole, actor, {
        ...updates,
        branch_id: 'branch_id' in updates ? updates.branch_id : existing.branch_id,
      });
      updates = { ...updates, branch_id: merged.branch_id };
    }
  }
  // Branch managers may only edit users inside their own branch and may not
  // touch / promote into admin / branch-manager roles. Evaluate against the
  // resulting role bucket and the (possibly new) primary manager.
  await assertBranchManagerScope(tenant, actor, {
    targetRole: updates.role ?? existing.role,
    targetUserId: id,
    managerId: Array.isArray(updates.manager_ids)
      ? (updates.manager_ids[0] ?? null)
      : (updates.manager_id ?? null),
  });
  // Don't let the last active super_admin deactivate themselves — would lock
  // everybody out. Same logic as the demote / delete guards above.
  if (updates.is_active === false && existing.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN && existing.is_active) {
    const others = await repo.list(tenant, { role: SYSTEM_TENANT_ROLES.SUPER_ADMIN, is_active: 'true', page: 1, limit: 2 });
    if (others.total <= 1) throw forbidden('Cannot deactivate the last super_admin');
  }

  // Platform-wide phone registry sync. Only when the phone actually changes.
  // Claim the new number BEFORE the DB write so an enforced collision blocks
  // the update; release the old number after. In soft mode claim never throws.
  const phoneChanging = 'phone' in updates && (updates.phone ?? '') !== (existing.phone ?? '');
  if (phoneChanging && updates.phone) {
    await phoneDirectory.claimPhone({ phone: updates.phone, tenantId: tenant.id, userId: id });
  }

  // Sync manager_ids[] to join table; mirror first into manager_id.
  let patch = { ...updates };
  if (Array.isArray(updates.manager_ids)) {
    patch.manager_id = updates.manager_ids[0] ?? null;
    delete patch.manager_ids;
    await repo.setManagers(tenant, id, updates.manager_ids);
  }
  const result = await repo.update(tenant, id, patch);

  // After a successful write, release the old number (if it changed / cleared).
  if (phoneChanging && existing.phone) {
    await phoneDirectory.releasePhone(existing.phone).catch(() => {});
  }
  return result;
};

export const deleteUser = async (tenant, id, actor) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('User not found');
  if (existing.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    const others = await repo.list(tenant, { role: SYSTEM_TENANT_ROLES.SUPER_ADMIN, is_active: 'true', page: 1, limit: 2 });
    if (others.total <= 1) throw forbidden('Cannot delete the last super_admin');
  }
  if (actor?.id === id) throw forbidden('Cannot delete yourself');
  // Branch managers may only delete users inside their own branch and never
  // an admin / fellow branch manager.
  await assertBranchManagerScope(tenant, actor, {
    targetRole: existing.role,
    targetUserId: id,
    managerId: null,
  });
  await repo.softDelete(tenant, id);
  // Free the number platform-wide so it can be reused.
  if (existing.phone) await phoneDirectory.releasePhone(existing.phone).catch(() => {});
};

export const resetPassword = async (tenant, id, new_password, actor) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('User not found');
  // Branch managers may only reset passwords for users inside their branch.
  await assertBranchManagerScope(tenant, actor, {
    targetRole: row.role,
    targetUserId: id,
    managerId: null,
  });
  const hash = await argon2.hash(new_password, HASH_OPTS);
  await repo.updatePasswordHash(tenant, id, hash);
};

export const updatePermissions = async (tenant, id, permissions_json, actor) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('User not found');
  // Branch managers may only change permissions for users inside their branch.
  await assertBranchManagerScope(tenant, actor, {
    targetRole: row.role,
    targetUserId: id,
    managerId: null,
  });
  return repo.update(tenant, id, { permissions_json });
};

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
      // Walk UP the reporting tree from the actor. Postgres allows exactly ONE
      // non-recursive anchor term; the recursive part must be a single
      // SELECT that references the CTE once. We combine both upward paths —
      // the legacy users.manager_id chain AND the user_managers join — inside
      // one recursive step via a LEFT JOIN to user_managers + an OR, instead
      // of two separate recursive UNION branches (which Postgres rejects with
      // "recursive reference ... must not appear within its non-recursive term").
      `WITH RECURSIVE chain AS (
         SELECT id, manager_id FROM users WHERE id = $1 AND deleted_at IS NULL
         UNION
         SELECT up.id, up.manager_id
           FROM chain c
           LEFT JOIN user_managers um ON um.user_id = c.id
           JOIN users up
             ON up.id = c.manager_id OR up.id = um.manager_id
          WHERE up.deleted_at IS NULL
       )
       SELECT id FROM chain`,
      [actor.id],
    );
    const { rows: admins } = await tenantQuery(
      tenant,
      `SELECT id FROM users WHERE role = $1 AND deleted_at IS NULL AND is_active = true`,
      [SYSTEM_TENANT_ROLES.SUPER_ADMIN],
    );
    // Branch managers run a whole branch, not just a manager_id subtree — so
    // their org tree includes EVERY active user in their branch (all sales
    // managers, counsellors, account managers under that branch_id), even if
    // those users don't report to the BM directly via manager_id.
    let branchMemberIds = [];
    if (actor.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER) {
      const me = await repo.findById(tenant, actor.id);
      if (me?.branch_id) {
        const { rows: branchRows } = await tenantQuery(
          tenant,
          `SELECT id FROM users WHERE branch_id = $1 AND deleted_at IS NULL AND is_active = true`,
          [me.branch_id],
        );
        branchMemberIds = branchRows.map((r) => r.id);
      }
    }
    const set = new Set([
      ...team,
      ...branchMemberIds,
      ...chainRows.map((r) => r.id),
      ...admins.map((a) => a.id),
      actor.id,
    ]);
    userIds = Array.from(set);
  }

  if (!userIds.length) return { nodes: [], edges: [] };

  const { rows: nodes } = await tenantQuery(
    tenant,
    `SELECT u.id, u.name, u.email, u.role, u.designation, u.manager_id, u.is_active,
            u.branch_id, b.name AS branch_name
       FROM users u
       LEFT JOIN branches b ON b.id = u.branch_id AND b.deleted_at IS NULL
      WHERE u.id = ANY($1::uuid[]) AND u.deleted_at IS NULL
      ORDER BY u.role DESC, u.name`,
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

// Self-service phone update for the logged-in user (mandatory phone-capture
// popup on the web). Enforces platform-wide uniqueness via the phone directory
// with the same claim -> write -> release-old ordering as updateUser: claim
// first so an enforced collision (a number owned by another user) throws 409
// before we touch the row; release the old number only after a successful write.
export const updateMyPhone = async (tenant, actor, body) => {
  const existing = await repo.findById(tenant, actor.id);
  if (!existing) throw notFound('User not found');

  const phoneChanging = (body.phone ?? '') !== (existing.phone ?? '');
  if (phoneChanging && body.phone) {
    await phoneDirectory.claimPhone({ phone: body.phone, tenantId: tenant.id, userId: actor.id });
  }

  const { rows } = await tenantQuery(
    tenant,
    `UPDATE users SET phone = $2, updated_at = now() WHERE id = $1 RETURNING phone`,
    [actor.id, body.phone],
  );

  if (phoneChanging && existing.phone) {
    await phoneDirectory.releasePhone(existing.phone).catch(() => {});
  }
  return { phone: rows[0]?.phone ?? body.phone };
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
