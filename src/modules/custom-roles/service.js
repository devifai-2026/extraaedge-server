import * as repo from './repo.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { tenantQuery } from '../../db/tenant.js';
import { notifyUser } from '../../lib/socket.js';
import { logger } from '../../lib/logger.js';

// Drop any tab_permissions entry that doesn't apply to the role's scope.
// Mirrors isTabApplicable() in the FE editor — the FE disables those
// rows, this is the server-side guarantee that nobody can sneak them in
// via a direct API call.
//
// Rule:
//   - account_manager scope → only 'accounts.*' tabs allowed.
//   - super_admin / branch_manager → admin-like, ALL tabs allowed (they
//     oversee the whole tenant / branch, including the Accounts module run by
//     account managers under them).
//   - every other scope (sales_manager, counsellor) → any tab EXCEPT
//     'accounts.*'.
const ALL_TABS_SCOPES = ['super_admin', 'branch_manager'];
const sanitizeTabPermissions = (scope, tabPermissions) => {
  if (!tabPermissions || typeof tabPermissions !== 'object') return tabPermissions;
  if (ALL_TABS_SCOPES.includes(scope)) return tabPermissions;
  const out = {};
  for (const [k, v] of Object.entries(tabPermissions)) {
    const isAccounts = k.startsWith('accounts.');
    const applicable = scope === 'account_manager' ? isAccounts : !isAccounts;
    if (applicable) out[k] = v;
  }
  return out;
};

export const listRoles = (tenant) => repo.list(tenant);

export const getRole = async (tenant, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('Role not found');
  return row;
};

export const createRole = async (tenant, input) => {
  if (await repo.findByName(tenant, input.name)) throw conflict('Role name already exists');
  const sanitized = {
    ...input,
    tab_permissions: sanitizeTabPermissions(input.scope, input.tab_permissions),
  };
  return repo.insert(tenant, sanitized);
};

export const updateRole = async (tenant, id, updates) => {
  const role = await repo.findById(tenant, id);
  if (!role) throw notFound('Role not found');
  if (role.is_system) {
    // Allow editing tab_permissions/feature_permissions but not name/scope
    delete updates.name;
    delete updates.scope;
  }
  if (updates.name && updates.name !== role.name) {
    const clash = await repo.findByName(tenant, updates.name);
    if (clash) throw conflict('Role name already exists');
  }
  delete updates.is_system;
  // Sanitize tab_permissions against the role's scope (unchanged on edit
  // for system roles, or whatever updates.scope was for user-defined ones).
  if (updates.tab_permissions !== undefined) {
    const effectiveScope = updates.scope ?? role.scope;
    updates.tab_permissions = sanitizeTabPermissions(effectiveScope, updates.tab_permissions);
  }
  const updated = await repo.update(tenant, id, updates);

  // If tab_permissions changed, push a refresh signal to every active user
  // currently assigned this role so their FE re-fetches /auth/me and the
  // sidebar / route-gates update in real time without a re-login.
  const tabPermsChanged = updates.tab_permissions !== undefined;
  if (tabPermsChanged) {
    try {
      const { rows } = await tenantQuery(
        tenant,
        `SELECT id FROM users WHERE role_id = $1 AND deleted_at IS NULL AND is_active = true`,
        [id],
      );
      for (const u of rows) {
        notifyUser(tenant.id, u.id, 'role.tab_permissions_changed', {
          role_id: id,
          role_name: updated.name,
        });
      }
    } catch (err) {
      // Non-fatal: the role IS updated; users just won't get the live
      // refresh and will see the change on their next page load.
      logger.warn({ err: err.message, role_id: id }, 'role tab_permissions broadcast failed');
    }
  }

  return updated;
};

export const deleteRole = async (tenant, id) => {
  const role = await repo.findById(tenant, id);
  if (!role) throw notFound('Role not found');
  if (role.is_system) throw forbidden('System roles cannot be deleted');
  const count = await repo.countUsersWithRole(tenant, id);
  if (count > 0) throw conflict(`Role is assigned to ${count} active user(s); reassign them first`);
  await repo.softDelete(tenant, id);
};
