import argon2 from 'argon2';
import * as repo from './repo.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import { recordPlatformAudit } from '../../services/platform-audit.js';

const HASH_OPTS = { type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1 };

export const listPlatformUsers = () => repo.list();
export const getPlatformUser = async (id) => {
  const row = await repo.findById(id);
  if (!row) throw notFound('Platform user not found');
  return row;
};

export const createPlatformUser = async ({ input, actor }) => {
  // Enforce: only product_owner can create platform users, and there must be only one product_owner.
  // Second constraint is already enforced by the partial unique index in the migration.
  const existing = await repo.findByEmail(input.email);
  if (existing) throw conflict('email already in use');

  if (input.role === PLATFORM_ROLES.PRODUCT_OWNER) {
    throw forbidden('Cannot create additional product_owner via API; use bootstrap script.');
  }

  const password_hash = await argon2.hash(input.password, HASH_OPTS);
  const row = await repo.insert({ ...input, password_hash });
  await recordPlatformAudit({
    platform_user_id: actor.id,
    action: 'platform_user.created',
    entity_type: 'platform_user',
    entity_id: row.id,
    after_json: { email: row.email, role: row.role },
  });
  return row;
};

export const updatePlatformUser = async ({ id, updates, actor }) => {
  const before = await repo.findById(id);
  if (!before) throw notFound('Platform user not found');
  if (before.role === PLATFORM_ROLES.PRODUCT_OWNER && actor.id !== id) {
    throw forbidden('Only the product_owner can modify their own record');
  }
  const row = await repo.update(id, updates);
  await recordPlatformAudit({
    platform_user_id: actor.id,
    action: 'platform_user.updated',
    entity_type: 'platform_user',
    entity_id: id,
    before_json: before,
    after_json: row,
  });
  return row;
};

export const deletePlatformUser = async ({ id, actor }) => {
  const before = await repo.findById(id);
  if (!before) throw notFound('Platform user not found');
  if (before.role === PLATFORM_ROLES.PRODUCT_OWNER) {
    throw forbidden('product_owner cannot be deleted');
  }
  await repo.softDelete(id);
  await recordPlatformAudit({
    platform_user_id: actor.id,
    action: 'platform_user.deleted',
    entity_type: 'platform_user',
    entity_id: id,
    before_json: before,
  });
};

export const verifyPassword = async ({ email, password }) => {
  const user = await repo.findByEmail(email);
  if (!user || !user.is_active) return null;
  const ok = await argon2.verify(user.password_hash, password);
  return ok ? user : null;
};

export const touchLogin = repo.touchLogin;
export const createSession = repo.insertSession;
export const findSessionByTokenHash = repo.findSessionByTokenHash;
export const touchSession = repo.touchSession;
export const revokeSession = repo.revokeSession;
export const getSessionLastActivity = repo.getSessionLastActivity;
