// Bootstrap the ONE product_owner. Re-running is a no-op if one exists.
// Usage:
//   node scripts/create-product-owner.js --name="Subho" [email protected] --password='...'

import argon2 from 'argon2';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { PLATFORM_ROLES } from '../src/config/constants.js';
import { logger } from '../src/lib/logger.js';

const parseArgs = () => Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));

const main = async () => {
  const args = parseArgs();
  if (!args.name || !args.email || !args.password) {
    logger.error('Usage: --name="..." --email="..." --password="..."');
    process.exit(1);
  }
  const { rows: existing } = await sysQuery(
    `SELECT id, email FROM platform_users WHERE role = $1 AND deleted_at IS NULL AND is_active = true`,
    [PLATFORM_ROLES.PRODUCT_OWNER],
  );
  if (existing[0]) {
    logger.info({ email: existing[0].email }, 'product_owner already exists — nothing to do');
    return;
  }
  const hash = await argon2.hash(args.password, { type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1 });
  const { rows } = await sysQuery(
    `INSERT INTO platform_users (name, email, phone, password_hash, role, is_active) VALUES ($1,$2,$3,$4,$5,true) RETURNING id, email`,
    [args.name, args.email, args.phone ?? null, hash, PLATFORM_ROLES.PRODUCT_OWNER],
  );
  logger.info({ product_owner: rows[0] }, 'product_owner bootstrapped');
};

main()
  .then(() => closeSystemPool())
  .catch(async (err) => { logger.fatal({ err: err.message }, 'failed'); await closeSystemPool(); process.exit(1); });
