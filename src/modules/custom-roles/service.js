import * as repo from './repo.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { tenantQuery } from '../../db/tenant.js';
import { notifyUser } from '../../lib/socket.js';
import { logger } from '../../lib/logger.js';

export const listRoles = (tenant) => repo.list(tenant);

export const getRole = async (tenant, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('Role not found');
  return row;
};

export const createRole = async (tenant, input) => {
  if (await repo.findByName(tenant, input.name)) throw conflict('Role name already exists');
  return repo.insert(tenant, input);
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
