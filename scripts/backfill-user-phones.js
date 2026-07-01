// Backfill the platform-wide user_phone_directory (system DB) from every
// tenant's users.phone. Run once after the user_phone_directory migration.
//
//   node scripts/backfill-user-phones.js
//
// Oldest-wins on cross-tenant collisions: the first (tenant,user) to claim a
// normalized number keeps it; later duplicates are LOGGED (not written) so an
// operator can resolve them before flipping PHONE_UNIQUENESS_ENFORCED=true.
// The script never fails on a collision — it reports a summary at the end.
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { last10Digits } from '../src/lib/phone.js';
import { logger } from '../src/lib/logger.js';

const main = async () => {
  const { rows: tenants } = await sysQuery(
    `SELECT id, slug, name, status, db_name, db_user, db_password_encrypted
       FROM tenants
      WHERE status = 'active' AND deleted_at IS NULL
      ORDER BY created_at`,
  );

  // phone_digits -> { tenant_id, user_id, slug } of the FIRST claimant.
  const claimed = new Map();
  const collisions = [];
  let inserted = 0;
  let scanned = 0;

  for (const tenant of tenants) {
    let users;
    try {
      const r = await tenantQuery(
        tenant,
        `SELECT id, phone FROM users WHERE deleted_at IS NULL AND phone IS NOT NULL AND phone <> ''`,
      );
      users = r.rows;
    } catch (err) {
      logger.error({ slug: tenant.slug, err: err.message }, 'backfill: could not read tenant users');
      continue;
    }

    for (const u of users) {
      scanned += 1;
      const digits = last10Digits(u.phone);
      if (digits.length < 10) continue; // skip short/blank

      const prior = claimed.get(digits);
      if (prior) {
        collisions.push({
          phone_digits: digits,
          kept: { slug: prior.slug, user_id: prior.user_id },
          dropped: { slug: tenant.slug, user_id: u.id, phone: u.phone },
        });
        continue; // oldest-wins: do not overwrite
      }

      claimed.set(digits, { tenant_id: tenant.id, user_id: u.id, slug: tenant.slug });
      await sysQuery(
        `INSERT INTO user_phone_directory (phone_digits, tenant_id, user_id, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (phone_digits) DO NOTHING`,
        [digits, tenant.id, u.id],
      );
      inserted += 1;
    }
  }

  logger.info(
    { tenants: tenants.length, scanned, inserted, collisions: collisions.length },
    'backfill-user-phones: done',
  );
  if (collisions.length) {
    logger.warn('backfill-user-phones: cross-tenant/duplicate phone collisions (resolve before enforcing):');
    for (const c of collisions) {
      logger.warn(
        { phone: c.phone_digits, kept: c.kept, dropped: c.dropped },
        'phone collision',
      );
    }
  }

  await closeAllTenantPools();
  await closeSystemPool();
};

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'backfill-user-phones failed');
  process.exit(1);
});
