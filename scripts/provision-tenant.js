// Provision a tenant manually (equivalent of POST /platform/tenants but without HTTP).
// Usage:
//   node scripts/provision-tenant.js --name="Speedup" --slug="speedup" --admin-email="owner@speedup.in" --admin-password="..." --admin-name="Owner"

import { createTenant } from '../src/modules/tenants/service.js';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { PLATFORM_ROLES } from '../src/config/constants.js';
import { logger } from '../src/lib/logger.js';

const parseArgs = () => Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));

const main = async () => {
  const args = parseArgs();
  if (!args.name || !args.slug || !args['admin-email'] || !args['admin-password'] || !args['admin-name']) {
    logger.error('Usage: --name --slug --admin-name --admin-email --admin-password');
    process.exit(1);
  }
  const { rows: po } = await sysQuery(
    `SELECT id FROM platform_users WHERE role = $1 AND deleted_at IS NULL AND is_active = true LIMIT 1`,
    [PLATFORM_ROLES.PRODUCT_OWNER],
  );
  if (!po[0]) {
    logger.error('No product_owner found — run create-product-owner.js first.');
    process.exit(1);
  }
  const tenant = await createTenant({
    input: {
      name: args.name,
      slug: args.slug,
      company_name: args['company-name'] ?? args.name,
      brand_name: args['brand-name'] ?? args.name,
      first_admin: {
        name: args['admin-name'],
        email: args['admin-email'],
        phone: args['admin-phone'],
        password: args['admin-password'],
      },
    },
    platform_user_id: po[0].id,
    ip: 'cli',
    user_agent: 'provision-script',
  });
  logger.info({ tenant: { id: tenant.id, slug: tenant.slug, db_name: tenant.db_name } }, 'tenant provisioned');
};

main()
  .then(() => closeSystemPool())
  .catch(async (err) => { logger.fatal({ err: err.message, stack: err.stack }, 'provision failed'); await closeSystemPool(); process.exit(1); });
