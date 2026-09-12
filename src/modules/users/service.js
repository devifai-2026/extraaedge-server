import argon2 from 'argon2';
import * as repo from './repo.js';
import * as roleRepo from '../custom-roles/repo.js';
import * as phoneDirectory from './phone-directory.js';
import { appError, conflict, forbidden, notFound, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, TEAM_SCOPED_MANAGER_ROLES, LEAD_OWNER_ROLES, EXPECTED_SUPERVISOR, RESPONSE_CODES } from '../../config/constants.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';
import { generateOtp, hashOtp, otpExpiryDate } from '../../lib/otp.js';
import { sendPhoneOtp } from '../../lib/providers/whatsapp-wabridge.js';
import { logger } from '../../lib/logger.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { notifyUser } from '../../lib/socket.js';
import * as leadRepo from '../leads/repo.js';
import * as authRepo from '../auth/repo.js';
import * as routingRepo from '../lead-routing/repo.js';

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

// A branch_manager's user list is scoped to their branch subtree (their
// teamHierarchy: themselves + everyone reporting up to them), so the Users
// table + the dashboard counsellor picker no longer leak the whole tenant.
// super_admin / account_manager are unscoped.
export const listUsers = async (tenant, query, actor) => {
  if (actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER) {
    const ids = await repo.teamHierarchy(tenant, actor.id); // actor + subtree
    return repo.list(tenant, { ...query, scope_user_ids: ids.length ? ids : ['00000000-0000-0000-0000-000000000000'] });
  }
  return repo.list(tenant, query);
};

// Unscoped, unpaginated label source for filter dropdowns — see the route
// comment on /users/options for why this doesn't mirror listUsers' scoping.
export const listUserOptions = async (tenant) => repo.listOptions(tenant);

export const getUser = async (tenant, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('User not found');
  row.branch_ids = await repo.listUserBranchIds(tenant, id);
  return row;
};

// Refuse to create (or switch into) a front-line role when the reporting line
// it needs does not exist. Driven by EXPECTED_SUPERVISOR, so this is the same
// rule the org-tree warning reports — one definition, enforced at the write
// path instead of only described after the fact.
//
// Two ways it can fail, with different fixes, so they get different messages:
//   - nobody in the tenant holds the supervisor role at all → an admin has to
//     create/promote one first;
//   - a supervisor exists but this user's chain doesn't reach one → the
//     reporting manager is wrong or missing on this form.
//
// Deliberately NOT applied when the actor is assigning a manager that already
// satisfies the rule, and skipped entirely for roles with no declared
// supervisor, so nothing outside the declared pairs changes behaviour.
const assertSupervisorExists = async (tenant, { role, managerIds }) => {
  const rule = EXPECTED_SUPERVISOR.find((r) => r.role === role);
  if (!rule) return;

  const { rows: supervisors } = await tenantQuery(
    tenant,
    `SELECT id FROM users
      WHERE role = $1 AND is_active = true AND deleted_at IS NULL`,
    [rule.supervisor],
  );
  if (!supervisors.length) {
    throw appError({
      status: 400,
      code: RESPONSE_CODES.VALIDATION_FAILED,
      message: `No active ${rule.supervisorLabel} exists yet. Please contact your admin to add a ${rule.supervisorLabel} before adding ${rule.label}s.`,
      details: { code: 'missing_supervisor', role, supervisor_role: rule.supervisor },
    });
  }

  const ids = (managerIds || []).filter(Boolean);
  if (!ids.length) {
    throw appError({
      status: 400,
      code: RESPONSE_CODES.VALIDATION_FAILED,
      message: `A ${rule.label} needs a reporting manager. Please contact your admin to add your reporting manager.`,
      details: { code: 'missing_manager', role, supervisor_role: rule.supervisor },
    });
  }

  // Does any chosen manager reach the required supervisor role, at itself or
  // anywhere above it? Mirrors the org-tree walk: follows user_managers AND
  // legacy users.manager_id, and is cycle-safe.
  const { rows: reach } = await tenantQuery(
    tenant,
    `WITH RECURSIVE chain AS (
       SELECT id, role, manager_id FROM users
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
       UNION
       SELECT up.id, up.role, up.manager_id
         FROM chain c
         LEFT JOIN user_managers um ON um.user_id = c.id
         JOIN users up ON up.id = c.manager_id OR up.id = um.manager_id
        WHERE up.deleted_at IS NULL
     )
     SELECT 1 FROM chain WHERE role = $2 LIMIT 1`,
    [ids, rule.supervisor],
  );
  if (!reach.length) {
    throw appError({
      status: 400,
      code: RESPONSE_CODES.VALIDATION_FAILED,
      message: `A ${rule.label} must report to a ${rule.supervisorLabel} (directly or above). Please contact your admin to add your reporting manager.`,
      details: { code: 'supervisor_not_in_chain', role, supervisor_role: rule.supervisor },
    });
  }
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

  // The reporting line a front-line role depends on must already exist.
  await assertSupervisorExists(tenant, {
    role,
    managerIds: Array.isArray(input.manager_ids) && input.manager_ids.length
      ? input.manager_ids
      : (input.manager_id ? [input.manager_id] : []),
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
  // Additional branches for teaching staff (multi-branch). insert() ignores
  // branch_ids (explicit column list), so we sync the join table here.
  if (['head_trainer', 'trainer', 'hr', 'placement'].includes(role) && Array.isArray(input.branch_ids)) {
    await repo.setUserBranches(tenant, user.id, input.branch_ids);
  }

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
  // Unconditional for a branch_manager: the rule is "a BM reports to the admin",
  // not "a BM reports to the admin whenever someone happens to edit their role
  // or manager". Previously this only fired when role/manager_id/manager_ids was
  // in the patch, so a BM whose reporting line had been corrupted elsewhere was
  // never repaired by an ordinary edit. It recomputes the same admin id every
  // time, so making it unconditional costs one query and cannot drift.
  if (effectiveRole === SYSTEM_TENANT_ROLES.BRANCH_MANAGER) {
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
  // branch_ids is a join table, not a users column — pull it out of the patch
  // and sync it separately (only meaningful for teaching roles).
  const branchIds = updates.branch_ids;
  delete patch.branch_ids;
  const result = await repo.update(tenant, id, patch);
  const effRole = updates.role ?? existing.role;
  if (['head_trainer', 'trainer', 'hr', 'placement'].includes(effRole) && Array.isArray(branchIds)) {
    await repo.setUserBranches(tenant, id, branchIds);
  }

  // After a successful write, release the old number (if it changed / cleared).
  if (phoneChanging && existing.phone) {
    await phoneDirectory.releasePhone(existing.phone).catch(() => {});
  }
  return result;
};

// Open (unconverted, live) leads this user currently owns. The blocker for
// moving someone OUT of a lead-owning role — their queue has to go somewhere.
// Everything a departing user still OWNS that somebody else has to pick up.
//
// Deliberately only "live work", not history: a lead they own, a follow-up they
// still have to make, a student they guide, a course they teach. Historical
// stamps (created_by on a closed record, who logged an activity, an audit row)
// are left pointing at the deleted user on purpose — rewriting them would
// falsify the record of who did what.
//
// Soft delete is why this matters. deleteUser sets deleted_at rather than
// removing the row, so the FKs never fire and every one of these columns keeps
// pointing at somebody who no longer exists. On the live SpeedUp tenant that is
// 19,888 leads and 10,097 follow-ups per counsellor-shaped user.
//
// Each entry returns { key, label, count, reassignable } so one generic UI can
// render the blocker list for ANY role — counsellor, trainer, HR or placement —
// without a per-role branch.
const pendingWorkFor = async (tenant, user_id) => {
  const q = async (sql, params = [user_id]) => {
    const { rows } = await tenantQuery(tenant, sql, params).catch(() => ({ rows: [{ c: 0 }] }));
    return Number(rows[0]?.c ?? 0);
  };

  const [openLeads, openFollowups, guidedStudents, courses, liveClasses, poolMemberships, directReports] =
    await Promise.all([
      q(`SELECT count(*) c FROM leads
          WHERE assigned_to = $1 AND deleted_at IS NULL AND converted_at IS NULL`),
      q(`SELECT count(*) c FROM lead_followups f
          JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
         WHERE f.created_by = $1 AND f.deleted_at IS NULL AND f.status = 'planned'`),
      q(`SELECT count(*) c FROM admissions
          WHERE guided_by_counsellor_id = $1 AND deleted_at IS NULL
            AND status NOT IN ('dropped', 'completed')`),
      q(`SELECT count(*) c FROM course_trainers
          WHERE user_id = $1 AND deleted_at IS NULL`),
      q(`SELECT count(*) c FROM classes
          WHERE trainer_id = $1 AND deleted_at IS NULL AND starts_at >= now()`),
      // Routing pools store members in a uuid[], so a departing member silently
      // shrinks the rotation instead of erroring.
      q(`SELECT count(*) c FROM lead_routing_pools
          WHERE deleted_at IS NULL AND $1 = ANY(member_ids)`),
      q(`SELECT count(*) c FROM users
          WHERE manager_id = $1 AND deleted_at IS NULL`),
    ]);

  return [
    { key: 'open_leads', label: 'open leads', count: openLeads, reassignable: true },
    { key: 'planned_followups', label: 'planned follow-ups', count: openFollowups, reassignable: true },
    { key: 'guided_admissions', label: 'students they guide', count: guidedStudents, reassignable: true },
    { key: 'courses', label: 'courses they teach', count: courses, reassignable: true },
    { key: 'upcoming_classes', label: 'upcoming classes', count: liveClasses, reassignable: true },
    { key: 'routing_pools', label: 'lead-distribution pools', count: poolMemberships, reassignable: true },
    { key: 'direct_reports', label: 'people reporting to them', count: directReports, reassignable: true },
  ].filter((w) => w.count > 0);
};

// The successor must be able to actually do the job being handed over.
//
// Leads and follow-ups can only sit with a LEAD_OWNER_ROLES user (the same
// invariant assertLeadOwnerTarget enforces on every other write path), and a
// course needs somebody who teaches. Checked here so offboarding fails with a
// clear message instead of writing rows that a later guard rejects.
const assertSuccessorValid = async (tenant, successorId, work, departingId) => {
  if (successorId === departingId) {
    throw conflict('Pick somebody other than the person being removed');
  }
  const { rows: [succ] } = await tenantQuery(
    tenant,
    `SELECT id, name, role, is_active FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [successorId],
  );
  if (!succ) throw notFound('Successor not found');
  if (!succ.is_active) throw conflict(`${succ.name} is deactivated — pick an active user`);

  const needsOwner = work.some((w) => ['open_leads', 'planned_followups', 'guided_admissions'].includes(w.key));
  if (needsOwner && !LEAD_OWNER_ROLES.includes(succ.role)) {
    throw conflict(
      `${succ.name} is a ${String(succ.role).replace(/_/g, ' ')} and cannot hold leads. Pick a counsellor, telecaller or telecaller lead.`,
      { successor_role: succ.role },
    );
  }
  const needsTrainer = work.some((w) => ['courses', 'upcoming_classes'].includes(w.key));
  if (needsTrainer && !['trainer', 'head_trainer'].includes(succ.role)) {
    throw conflict(
      `${succ.name} is a ${String(succ.role).replace(/_/g, ' ')} and cannot take over courses. Pick a trainer or head trainer.`,
      { successor_role: succ.role },
    );
  }
  return succ;
};

// Move every piece of live work from one user to another, in a transaction.
//
// Used by offboarding. The successor must already be able to do the job — a
// counsellor's leads cannot go to a trainer — which the caller validates via
// assertSuccessorValid before we get here.
//
// Deliberately NOT touched: lead_activities, audit_log, message_log, and any
// created_by on a closed record. Those are history, and history keeps the name
// of whoever actually did it.
const transferOwnedWork = async (tenant, fromId, toId, actorId) => {
  return tenantTx(tenant, async (client) => {
    const moved = {};
    const run = async (key, sql) => {
      const { rowCount } = await client.query(sql, [fromId, toId]);
      if (rowCount) moved[key] = rowCount;
    };

    await run('leads', `UPDATE leads SET assigned_to = $2, manager_id = (SELECT manager_id FROM users WHERE id = $2), last_activity_at = now()
                         WHERE assigned_to = $1 AND deleted_at IS NULL AND converted_at IS NULL`);
    await run('followups', `UPDATE lead_followups SET created_by = $2
                             WHERE created_by = $1 AND deleted_at IS NULL AND status = 'planned'`);
    await run('admissions', `UPDATE admissions SET guided_by_counsellor_id = $2
                              WHERE guided_by_counsellor_id = $1 AND deleted_at IS NULL
                                AND status NOT IN ('dropped', 'completed')`);
    // A course the successor already teaches would violate the uniqueness the
    // roster assumes, so skip those rather than erroring the whole offboard.
    await run('courses', `UPDATE course_trainers ct SET user_id = $2
                           WHERE ct.user_id = $1 AND ct.deleted_at IS NULL
                             AND NOT EXISTS (
                               SELECT 1 FROM course_trainers x
                                WHERE x.program_id = ct.program_id AND x.user_id = $2 AND x.deleted_at IS NULL
                             )`);
    await run('classes', `UPDATE classes SET trainer_id = $2
                           WHERE trainer_id = $1 AND deleted_at IS NULL AND starts_at >= now()`);
    // uuid[] membership: swap in place so the pool keeps its rotation order.
    await run('routing_pools', `UPDATE lead_routing_pools
                                   SET member_ids = array_replace(member_ids, $1::uuid, $2::uuid)
                                 WHERE deleted_at IS NULL AND $1 = ANY(member_ids)
                                   AND NOT ($2 = ANY(member_ids))`);
    // Re-parent the team so nobody is left reporting to a deleted manager.
    await run('direct_reports', `UPDATE users SET manager_id = $2
                                  WHERE manager_id = $1 AND deleted_at IS NULL`);
    await client.query(
      `UPDATE user_managers SET manager_id = $2
        WHERE manager_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM user_managers x WHERE x.user_id = user_managers.user_id AND x.manager_id = $2
          )`,
      [fromId, toId],
    );
    // Drop any row the swap above would have duplicated.
    await client.query(`DELETE FROM user_managers WHERE manager_id = $1`, [fromId]);

    return moved;
  });
};

const openLeadsOwnedBy = async (tenant, user_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM leads
      WHERE assigned_to = $1 AND deleted_at IS NULL AND converted_at IS NULL`,
    [user_id],
  );
  return rows.map((r) => r.id);
};

// Move a person between roles — the counsellor / telecaller_lead / telecaller
// split this exists for, though it works for any bucket.
//
// A dedicated endpoint rather than another field on PUT /users/:id, because a
// role change has consequences a generic patch silently skips:
//
//   * the JWT still carries the OLD role and allowedTabs (middleware/auth.js
//     trusts the token and never re-reads the user row), so sessions must be
//     revoked or the change doesn't take effect until the token expires;
//   * a user leaving a lead-owning role leaves their queue pointing at an
//     owner the ownership invariant now rejects;
//   * routing pools and assignment rules may still name them;
//   * nothing was ever written to audit_log.
//
// NOTHING IS DELETED. The user row is updated in place, lead handovers append
// to the lead_assignments ledger, and pools/rules keep their member lists (the
// resolvers already ignore members who can't currently own a lead — stripping
// the id would throw away the admin's intent).
export const switchRole = async (tenant, id, { role_id, manager_ids, reassign_leads_to }, actor, reqMeta = {}) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('User not found');

  const scope = await resolveRoleFromRoleId(tenant, role_id);
  if (!scope) throw notFound('Role not found');

  if (scope === existing.role && role_id === existing.role_id) {
    throw conflict('User already holds that role');
  }

  // Never strand a tenant without an admin.
  if (existing.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN && scope !== SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    const others = await repo.list(tenant, { role: SYSTEM_TENANT_ROLES.SUPER_ADMIN, is_active: 'true', page: 1, limit: 2 });
    if (others.total <= 1) throw forbidden('Cannot demote the last super_admin');
  }

  // A branch_manager reports to the tenant admin, period — the same invariant
  // createUser and updateUser enforce via forceBranchManagerReporting. Without
  // this, switch-role was a way straight around that rule: promoting someone to
  // branch_manager with an arbitrary manager_ids[] re-parented them anywhere.
  //
  // Resolved HERE, before the three things that read the reporting line below
  // (assertBranchManagerScope, assertSupervisorExists and nextManagerIds), so
  // all of them see the forced value rather than what the client sent.
  const isBecomingBranchManager = scope === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;
  let effectiveManagerIds = Array.isArray(manager_ids) ? manager_ids : null;
  if (isBecomingBranchManager) {
    const adminId = await primarySuperAdminId(tenant);
    // A tenant mid-provisioning may have no super_admin yet; an empty list is
    // the honest answer there, exactly as forceBranchManagerReporting does.
    effectiveManagerIds = adminId ? [adminId] : [];
  }

  // A branch_manager may only move people inside their own branch, and never
  // into an admin / branch-head role. Same guard the create/update paths use.
  await assertBranchManagerScope(tenant, actor, {
    targetRole: scope,
    targetUserId: id,
    managerId: Array.isArray(effectiveManagerIds) ? effectiveManagerIds[0] ?? null : null,
  });

  // Same structural rule as creation: switching INTO a front-line role still
  // requires the reporting line that role depends on, otherwise switch-role
  // becomes a way around the create-time guard.
  await assertSupervisorExists(tenant, {
    role: scope,
    managerIds: Array.isArray(effectiveManagerIds) && effectiveManagerIds.length
      ? effectiveManagerIds
      : (existing.manager_id ? [existing.manager_id] : []),
  });

  // ---- Hand over the lead queue, if the new role can't own leads --------
  const wasOwner = LEAD_OWNER_ROLES.includes(existing.role);
  const willOwn = LEAD_OWNER_ROLES.includes(scope);
  let movedLeadIds = [];
  if (wasOwner && !willOwn) {
    const openLeadIds = await openLeadsOwnedBy(tenant, id);
    if (openLeadIds.length) {
      if (!reassign_leads_to) {
        throw conflict(
          `${existing.name} still owns ${openLeadIds.length} open lead(s). A ${scope} cannot own leads — choose who should take them over.`,
          { open_lead_count: openLeadIds.length, requires: 'reassign_leads_to' },
        );
      }
      if (reassign_leads_to === id) {
        throw conflict('Cannot hand the leads back to the same user');
      }
      // bulkAssign enforces the ownership invariant on the target, closes each
      // old lead_assignments row and appends a new one, and moves stageless
      // leads into the first active stage — the same path a manual bulk
      // reassign takes.
      await leadRepo.bulkAssign(tenant, {
        lead_ids: openLeadIds,
        assigned_to: reassign_leads_to,
        assigned_by: actor?.id ?? null,
        reason: `Role switch: ${existing.role} → ${scope}`,
      });
      movedLeadIds = openLeadIds;
    }
  }

  // ---- Flip the role ---------------------------------------------------
  // manager_ids defaults to keeping the current primary manager, so a switch
  // that doesn't mention reporting lines doesn't quietly orphan the user.
  // For a branch_manager this is the forced [admin] list resolved above — the
  // client's manager_ids is deliberately ignored for that role.
  const nextManagerIds = Array.isArray(effectiveManagerIds)
    ? effectiveManagerIds
    : (existing.manager_id ? [existing.manager_id] : []);
  await repo.setManagers(tenant, id, nextManagerIds);
  const updated = await repo.update(tenant, id, {
    role: scope,
    role_id,
    manager_id: nextManagerIds[0] ?? null,
  });

  // ---- Make it take effect + leave a trail -----------------------------
  await writeAuditLog(tenant, {
    userId: actor?.id ?? null,
    action: 'user.role_switched',
    entityType: 'user',
    entityId: id,
    ip: reqMeta.ip,
    userAgent: reqMeta.userAgent,
    beforeJson: { role: existing.role, role_id: existing.role_id, manager_id: existing.manager_id },
    afterJson: {
      role: scope,
      role_id,
      manager_id: nextManagerIds[0] ?? null,
      reassigned_lead_count: movedLeadIds.length,
      reassigned_leads_to: movedLeadIds.length ? reassign_leads_to : null,
    },
  });

  // The access token still carries the old role/allowedTabs — kill the
  // sessions so the next request re-authenticates into the new role.
  let revokedSessions = 0;
  try {
    revokedSessions = await authRepo.revokeAllForUser(tenant, id);
  } catch (err) {
    // The role IS switched; a revoke failure only delays it to token expiry.
    logger.warn({ err: err.message, userId: id }, 'role switch: session revoke failed');
  }
  // Live nudge for a tab open right now — Layout/Header already handles this
  // event by re-fetching /auth/me and re-gating the current route.
  try {
    notifyUser(tenant.id, id, 'role.tab_permissions_changed', { role: scope, role_id });
  } catch (err) {
    logger.warn({ err: err.message, userId: id }, 'role switch: live refresh push failed');
  }

  // Surface, don't mutate: tell the caller where this user is still named so
  // an admin can retune the routing deliberately.
  let referencedBy = { routing_pools: [] };
  try {
    referencedBy = { routing_pools: await routingRepo.poolsContainingUser(tenant, id) };
  } catch (err) {
    logger.warn({ err: err.message, userId: id }, 'role switch: pool reference lookup failed');
  }

  return {
    user: updated,
    previous_role: existing.role,
    reassigned_lead_count: movedLeadIds.length,
    revoked_sessions: revokedSessions,
    referenced_by: referencedBy,
  };
};

// Offboarding. `reassign_to` names the person who inherits the departing
// user's live work; omit it and the call fails with the full blocker list so
// the UI can show "X owns 412 leads and 9 students — who takes them?".
//
// Before this, delete was a bare soft-delete: deleted_at was set and every one
// of ~122 FK columns kept pointing at a user who no longer exists. FKs never
// fire on a soft delete, so nothing surfaced — leads, follow-ups, guided
// students, courses and whole reporting lines simply became invisible work.
// Read-only view of what a user still owns plus who could take it, so the
// offboarding dialog can be filled in one round trip.
export const offboardingPreview = async (tenant, id, actor) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('User not found');
  await assertBranchManagerScope(tenant, actor, {
    targetRole: existing.role,
    targetUserId: id,
    managerId: null,
  });

  const work = await pendingWorkFor(tenant, id);

  // Eligible successors depend on WHAT is being handed over, so the dialog
  // never offers somebody the transfer would then reject.
  const needsOwner = work.some((w) => ['open_leads', 'planned_followups', 'guided_admissions'].includes(w.key));
  const needsTrainer = work.some((w) => ['courses', 'upcoming_classes'].includes(w.key));
  let roles = null;
  if (needsOwner && needsTrainer) roles = [...LEAD_OWNER_ROLES, 'trainer', 'head_trainer'];
  else if (needsOwner) roles = [...LEAD_OWNER_ROLES];
  else if (needsTrainer) roles = ['trainer', 'head_trainer'];

  const { rows: candidates } = await tenantQuery(
    tenant,
    `SELECT id, name, email, role FROM users
      WHERE deleted_at IS NULL AND is_active = true AND id <> $1
        ${roles ? 'AND role = ANY($2)' : ''}
      ORDER BY name`,
    roles ? [id, roles] : [id],
  );

  return {
    user: { id: existing.id, name: existing.name, role: existing.role, email: existing.email },
    pending_work: work,
    requires_reassignment: work.length > 0,
    candidates,
  };
};

export const deleteUser = async (tenant, id, actor, { reassign_to } = {}) => {
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

  // ---- handover ---------------------------------------------------------
  const work = await pendingWorkFor(tenant, id);
  let moved = {};
  if (work.length) {
    if (!reassign_to) {
      const detail = work.map((w) => `${w.count} ${w.label}`).join(', ');
      throw conflict(
        `${existing.name} still owns ${detail}. Choose who should take this over before removing them.`,
        { pending_work: work, requires: 'reassign_to' },
      );
    }
    await assertSuccessorValid(tenant, reassign_to, work, id);
    moved = await transferOwnedWork(tenant, id, reassign_to, actor?.id ?? null);
  }

  await repo.softDelete(tenant, id);
  await writeAuditLog(tenant, {
    userId: actor?.id ?? null,
    action: 'user.offboarded',
    entityType: 'user',
    entityId: id,
    beforeJson: { name: existing.name, role: existing.role, email: existing.email },
    afterJson: { reassigned_to: reassign_to ?? null, moved },
  });
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

export const userWorkSessions = async (tenant, userId, { hours, from, to }) => {
  return repo.userWorkSessions(tenant, userId, { hours, from, to });
};

export const userActivitySummary = async (tenant, userId, { hours, from, to }) => {
  return repo.userActivitySummary(tenant, userId, { hours, from, to });
};

export const userLoginEvents = async (tenant, userId, { hours, from, to }) => {
  return repo.userLoginEvents(tenant, userId, { hours, from, to });
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
// Structural holes in the reporting tree, derived from EXPECTED_SUPERVISOR
// rather than hardcoded per role. For each declared pair we report either:
//   missing_supervisor — the role exists but NOBODY holds the supervisor role
//   unsupervised       — a supervisor exists, but some members don't report
//                        to one (directly or anywhere up their chain)
// Computed over the SAME visible node set the chart draws, so a manager is
// never warned about people they cannot see.
const detectOrgGaps = (nodes, edges) => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // user_id -> [manager_id]; a user can have several managers.
  const parents = new Map();
  for (const e of edges) {
    if (!parents.has(e.user_id)) parents.set(e.user_id, []);
    parents.get(e.user_id).push(e.manager_id);
  }

  // Does any ancestor of `id` hold `role`? Walks up every manager path,
  // guarding against cycles so a mis-set manager_id can't hang the request.
  const hasAncestorWithRole = (id, role) => {
    const seen = new Set([id]);
    const queue = [...(parents.get(id) || [])];
    while (queue.length) {
      const pid = queue.shift();
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      if (byId.get(pid)?.role === role) return true;
      queue.push(...(parents.get(pid) || []));
    }
    return false;
  };

  const gaps = [];
  for (const rule of EXPECTED_SUPERVISOR) {
    const members = nodes.filter((n) => n.role === rule.role && n.is_active !== false);
    if (!members.length) continue;
    const supervisors = nodes.filter((n) => n.role === rule.supervisor && n.is_active !== false);

    if (!supervisors.length) {
      gaps.push({
        code: 'missing_supervisor',
        role: rule.role,
        supervisor_role: rule.supervisor,
        count: members.length,
        // Names so the UI can show who is affected without another request.
        members: members.slice(0, 10).map((m) => m.name),
        message: `${members.length} ${rule.label}${members.length === 1 ? '' : 's'} with no ${rule.supervisorLabel}`,
      });
      continue;
    }

    const orphans = members.filter((m) => !hasAncestorWithRole(m.id, rule.supervisor));
    if (orphans.length) {
      gaps.push({
        code: 'unsupervised',
        role: rule.role,
        supervisor_role: rule.supervisor,
        count: orphans.length,
        members: orphans.slice(0, 10).map((m) => m.name),
        message: `${orphans.length} ${rule.label}${orphans.length === 1 ? '' : 's'} not reporting to a ${rule.supervisorLabel}`,
      });
    }
  }
  return gaps;
};

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

  return { nodes, edges, gaps: detectOrgGaps(nodes, edges) };
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

// --- OTP-verified phone RESET (web profile page) ---------------------------
// Unlike updateMyPhone (first-time capture in the popup), resetting an existing
// number requires proving control of the NEW number via a WhatsApp OTP.
// Reuses the otp_verifications table + lib/otp; channel 'whatsapp',
// purpose 'phone_change', scoped to (user_id, address=new phone).

// Step 1: generate + store an OTP and WhatsApp it to the requested new number.
export const sendPhoneChangeOtp = async (tenant, actor, newPhone) => {
  // Pre-check uniqueness so we don't send an OTP for a number the user can't
  // ultimately claim (enforced mode). Soft mode logs and proceeds.
  const existingClaim = await phoneDirectory.lookupByPhone(newPhone);
  if (existingClaim && existingClaim.user_id !== actor.id) {
    throw conflict('That phone number is already registered to another user on the platform');
  }
  const otp = generateOtp(6);
  const otp_hash = hashOtp(otp, newPhone);
  // Invalidate any prior pending phone_change OTPs for this user.
  await tenantQuery(
    tenant,
    `UPDATE otp_verifications SET verified_at = now()
      WHERE user_id = $1 AND purpose = 'phone_change' AND verified_at IS NULL`,
    [actor.id],
  );
  await tenantQuery(
    tenant,
    `INSERT INTO otp_verifications (user_id, purpose, channel, address, otp_hash, expires_at, max_attempts)
     VALUES ($1, 'phone_change', 'whatsapp', $2, $3, $4, 5)`,
    [actor.id, newPhone, otp_hash, otpExpiryDate()],
  );
  // Deliver via WhatsApp. Surface a send failure to the caller so the UI can
  // tell the user (unlike lead OTPs which are best-effort).
  await sendPhoneOtp({ to: newPhone, code: otp });
  logger.info({ user_id: actor.id }, 'phone-change OTP sent');
  return { sent: true };
};

// Step 2: verify the OTP for the new number, then update the phone with the
// same uniqueness claim/release as updateMyPhone.
export const verifyPhoneChangeOtp = async (tenant, actor, newPhone, code) => {
  const otp_hash = hashOtp(code, newPhone);
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE otp_verifications SET verified_at = now()
      WHERE user_id = $1 AND purpose = 'phone_change' AND address = $2
        AND verified_at IS NULL AND expires_at > now()
        AND otp_hash = $3 AND attempts < max_attempts
      RETURNING id`,
    [actor.id, newPhone, otp_hash],
  );
  if (!rows[0]) {
    await tenantQuery(
      tenant,
      `UPDATE otp_verifications SET attempts = attempts + 1
        WHERE user_id = $1 AND purpose = 'phone_change' AND address = $2 AND verified_at IS NULL`,
      [actor.id, newPhone],
    );
    throw validationError([{ path: 'code', message: 'Invalid or expired OTP' }]);
  }
  // OTP good — apply the change (reuse the claim/write/release path).
  const existing = await repo.findById(tenant, actor.id);
  const phoneChanging = (newPhone ?? '') !== (existing?.phone ?? '');
  if (phoneChanging) {
    await phoneDirectory.claimPhone({ phone: newPhone, tenantId: tenant.id, userId: actor.id });
  }
  await tenantQuery(
    tenant,
    `UPDATE users SET phone = $2, updated_at = now() WHERE id = $1`,
    [actor.id, newPhone],
  );
  if (phoneChanging && existing?.phone) {
    await phoneDirectory.releasePhone(existing.phone).catch(() => {});
  }
  return { phone: newPhone };
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
