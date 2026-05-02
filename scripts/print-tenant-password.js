// One-shot: print the decrypted db user / password for a tenant.
// Usage: node scripts/print-tenant-password.js --slug=demo
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { decrypt } from '../src/lib/crypto.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const slug = args.slug;
if (!slug) {
  console.error('Usage: node scripts/print-tenant-password.js --slug=<tenant_slug>');
  process.exit(1);
}

const { rows } = await sysQuery(
  `SELECT slug, db_name, db_user, db_password_encrypted FROM tenants WHERE slug = $1 AND deleted_at IS NULL`,
  [slug],
);
if (!rows[0]) {
  console.error(`No tenant with slug "${slug}"`);
  process.exit(1);
}
const t = rows[0];
console.log('Database :', t.db_name);
console.log('Username :', t.db_user);
console.log('Password :', decrypt(t.db_password_encrypted));
await closeSystemPool();
