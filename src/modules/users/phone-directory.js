// Platform-wide user-phone registry (system DB). See the
// system/..._user_phone_directory.cjs migration for the rationale.
//
// claimPhone enforces that a phone number belongs to exactly one (tenant,user)
// across the WHOLE platform. Rollout is soft: when PHONE_UNIQUENESS_ENFORCED
// is false, a collision with a DIFFERENT user is logged and swallowed (the
// tenant's own users.phone still updates); when true, it throws 409.
//
// A phone re-claimed by the SAME (tenant,user) is always fine (idempotent
// updates, e.g. an admin editing an unrelated field).
import { sysQuery } from '../../db/system.js';
import { env } from '../../config/env.js';
import { conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { last10Digits } from '../../lib/phone.js';

export const lookupByPhone = async (phone) => {
  const digits = last10Digits(phone);
  if (digits.length < 10) return null;
  const { rows } = await sysQuery(
    `SELECT phone_digits, tenant_id, user_id FROM user_phone_directory WHERE phone_digits = $1`,
    [digits],
  );
  return rows[0] ?? null;
};

// Register (or move) a phone to a given tenant+user. Returns the normalized
// digits actually claimed, or null when the input has < 10 digits (nothing to
// claim — we simply don't track short/blank numbers).
export const claimPhone = async ({ phone, tenantId, userId }) => {
  const digits = last10Digits(phone);
  if (digits.length < 10) return null;

  const existing = await lookupByPhone(digits);
  if (existing && existing.user_id !== userId) {
    // Collision with a different user somewhere on the platform.
    if (env.PHONE_UNIQUENESS_ENFORCED) {
      throw conflict('Phone number is already registered to another user on the platform', {
        phone_digits: digits,
      });
    }
    logger.warn(
      { phone_digits: digits, existing_tenant: existing.tenant_id, existing_user: existing.user_id, incoming_tenant: tenantId, incoming_user: userId },
      'phone-directory: cross-user collision (soft mode — not enforced)',
    );
    // Soft mode: take over the registry row so it reflects the latest write,
    // but do not block the tenant users.phone update.
  }

  await sysQuery(
    `INSERT INTO user_phone_directory (phone_digits, tenant_id, user_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (phone_digits)
       DO UPDATE SET tenant_id = EXCLUDED.tenant_id, user_id = EXCLUDED.user_id, updated_at = now()`,
    [digits, tenantId, userId],
  );
  return digits;
};

export const releasePhone = async (phone) => {
  const digits = last10Digits(phone);
  if (digits.length < 10) return;
  await sysQuery(`DELETE FROM user_phone_directory WHERE phone_digits = $1`, [digits]);
};
