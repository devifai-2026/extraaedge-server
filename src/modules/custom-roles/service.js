import * as repo from './repo.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';

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
  return repo.update(tenant, id, updates);
};

export const deleteRole = async (tenant, id) => {
  const role = await repo.findById(tenant, id);
  if (!role) throw notFound('Role not found');
  if (role.is_system) throw forbidden('System roles cannot be deleted');
  const count = await repo.countUsersWithRole(tenant, id);
  if (count > 0) throw conflict(`Role is assigned to ${count} active user(s); reassign them first`);
  await repo.softDelete(tenant, id);
};
