import argon2 from 'argon2';
import * as repo from './repo.js';
import * as roleRepo from '../custom-roles/repo.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

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

  // super_admin role should default track_work_time=false
  const track_work_time = input.track_work_time ?? (input.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN);
  const password_hash = await argon2.hash(input.password, HASH_OPTS);
  return repo.insert(tenant, { ...input, track_work_time }, password_hash);
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
  return repo.update(tenant, id, updates);
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

export const updatedAtLoader = (tenant) => async (req) => repo.getUpdatedAt(tenant, req.params.id);
