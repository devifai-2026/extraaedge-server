import * as repo from './repo.js';
import * as leadsRepo from '../leads/repo.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { conflict, notFound, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

export const listBranches = (tenant) => repo.list(tenant);

export const getBranch = async (tenant, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('Branch not found');
  return row;
};

// The branch the actor belongs to (their users.branch_id). Used to scope a
// branch_manager to their own branch.
export const branchOfUser = async (tenant, user_id) => {
  if (!user_id) return null;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT branch_id FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [user_id],
  );
  return rows[0]?.branch_id ?? null;
};

// Validate that a proposed branch_manager_id points at an active user whose
// role is branch_manager. Throws otherwise. Null is allowed (branch with no
// head yet).
const assertValidManager = async (tenant, branch_manager_id) => {
  if (!branch_manager_id) return;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT role FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active = true`,
    [branch_manager_id],
  );
  if (!rows[0]) throw validationError({ branch_manager_id: 'User not found or inactive' });
  if (rows[0].role !== SYSTEM_TENANT_ROLES.BRANCH_MANAGER) {
    throw validationError({ branch_manager_id: 'User must have the branch_manager role' });
  }
};

export const createBranch = async (tenant, input) => {
  if (await repo.findByName(tenant, input.name)) throw conflict('A branch with this name already exists');
  await assertValidManager(tenant, input.branch_manager_id);
  if (input.branch_manager_id && await repo.findByManager(tenant, input.branch_manager_id)) {
    throw conflict('That branch manager already heads another branch');
  }
  const branch = await repo.insert(tenant, input);
  // The head belongs to their own branch.
  if (branch.branch_manager_id) {
    await repo.setUserBranch(tenant, branch.branch_manager_id, branch.id);
  }
  return repo.findById(tenant, branch.id);
};

export const updateBranch = async (tenant, id, updates) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Branch not found');
  if (updates.name && updates.name.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await repo.findByName(tenant, updates.name);
    if (clash && clash.id !== id) throw conflict('A branch with this name already exists');
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'branch_manager_id')) {
    await assertValidManager(tenant, updates.branch_manager_id);
    if (updates.branch_manager_id) {
      const heads = await repo.findByManager(tenant, updates.branch_manager_id);
      if (heads && heads.id !== id) throw conflict('That branch manager already heads another branch');
    }
  }
  const updated = await repo.update(tenant, id, updates);
  // Keep the head's own branch_id in sync when the manager changes.
  if (Object.prototype.hasOwnProperty.call(updates, 'branch_manager_id') && updates.branch_manager_id) {
    await repo.setUserBranch(tenant, updates.branch_manager_id, id);
  }
  return updated;
};

export const deleteBranch = async (tenant, id) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Branch not found');
  const count = await repo.memberCount(tenant, id);
  if (count > 0) {
    throw conflict(`Branch has ${count} member(s); move them to another branch first`);
  }
  await repo.softDelete(tenant, id);
};

// First-run onboarding: create the tenant's first branch AND move everyone
// into it in one atomic step. Used by the admin's "set up branch" wizard:
//   1. create the branch (validated head, unique name, one-per-manager)
//   2. set the head's own branch_id
//   3. adopt all branch-less non-super_admin users into the branch
//   4. stamp the branch on EVERY branch-less lead (single-branch tenant ⇒ no
//      lead left behind; future splits move leads via reassignment)
// Returns the branch plus counts so the wizard can confirm what moved.
export const createBranchAndAdopt = async (tenant, input) => {
  if (await repo.findByName(tenant, input.name)) throw conflict('A branch with this name already exists');
  await assertValidManager(tenant, input.branch_manager_id);
  if (input.branch_manager_id && await repo.findByManager(tenant, input.branch_manager_id)) {
    throw conflict('That branch manager already heads another branch');
  }

  const result = await tenantTx(tenant, async (client) => {
    const { rows: branchRows } = await client.query(
      `INSERT INTO branches (name, code, branch_manager_id, is_active)
       VALUES ($1, $2, $3, COALESCE($4, true))
       RETURNING id`,
      [input.name, input.code ?? null, input.branch_manager_id ?? null, input.is_active ?? null],
    );
    const branchId = branchRows[0].id;
    // Head belongs to their own branch.
    if (input.branch_manager_id) {
      await client.query(
        `UPDATE users SET branch_id = $2 WHERE id = $1 AND deleted_at IS NULL`,
        [input.branch_manager_id, branchId],
      );
    }
    const usersAdopted = await repo.adoptUnbranchedUsers(client, branchId);
    const leadsBackfilled = await leadsRepo.stampBranchOnUnbranchedLeads(client, branchId);
    return { branchId, usersAdopted, leadsBackfilled };
  });

  const branch = await repo.findById(tenant, result.branchId);
  return {
    branch,
    users_adopted: result.usersAdopted,
    leads_backfilled: result.leadsBackfilled,
  };
};

// Assign / move a user into a branch (admin action). Validates the branch
// exists; pass branch_id=null to clear.
export const assignUser = async (tenant, branch_id, user_id) => {
  if (branch_id) {
    const branch = await repo.findById(tenant, branch_id);
    if (!branch) throw notFound('Branch not found');
  }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [user_id],
  );
  if (!rows[0]) throw notFound('User not found');
  await repo.setUserBranch(tenant, user_id, branch_id);
  return { user_id, branch_id: branch_id ?? null };
};
