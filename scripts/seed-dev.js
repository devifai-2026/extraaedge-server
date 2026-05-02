// Seed the demo tenant with sample programs, users, and leads for manual testing.
import argon2 from 'argon2';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { resolveTenantBySlug, tenantQuery } from '../src/db/tenant.js';
import { logger } from '../src/lib/logger.js';

const parseArgs = () => Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));

const main = async () => {
  const args = parseArgs();
  const slug = args.slug ?? 'demo';
  const tenant = await resolveTenantBySlug(slug);

  const hash = await argon2.hash('ChangeMe123!', { type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1 });
  const { rows: [roleMgr] } = await tenantQuery(tenant, `SELECT id FROM custom_roles WHERE name = 'sales_manager' AND deleted_at IS NULL`);
  const { rows: [roleCouns] } = await tenantQuery(tenant, `SELECT id FROM custom_roles WHERE name = 'counsellor' AND deleted_at IS NULL`);

  await tenantQuery(tenant, `
    INSERT INTO users (name, email, phone, password_hash, role, role_id) VALUES
      ('Manager One', '[email protected]', '+919800000001', $1, 'sales_manager', $2),
      ('Counsellor One', '[email protected]', '+919800000002', $1, 'counsellor', $3),
      ('Counsellor Two', '[email protected]', '+919800000003', $1, 'counsellor', $3)
    ON CONFLICT (email) DO NOTHING`,
    [hash, roleMgr.id, roleCouns.id]);

  await tenantQuery(tenant, `
    INSERT INTO programs (name, code, category, type, price, currency, duration_value, duration_unit, is_active)
    VALUES
      ('Data Science Bootcamp', 'DS-001', 'domestic', 'online', 125000, 'INR', 6, 'months', true),
      ('MBA Finance', 'MBA-FIN', 'domestic', 'offline', 350000, 'INR', 2, 'years', true),
      ('IELTS Coaching', 'IELTS-1', 'coaching', 'hybrid', 25000, 'INR', 3, 'months', true)
    ON CONFLICT (code) DO NOTHING`);

  const { rows: [newStage] } = await tenantQuery(tenant, `SELECT id FROM lead_stages WHERE code = '01-New'`);
  const { rows: [counsellor] } = await tenantQuery(tenant, `SELECT id FROM users WHERE email = '[email protected]'`);

  for (let i = 1; i <= 10; i += 1) {
    await tenantQuery(tenant, `
      INSERT INTO leads (name, first_name, last_name, email, phone, whatsapp_number, gender, stage_id, assigned_to, created_by, language)
      VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $8, 'en')
      ON CONFLICT DO NOTHING`,
      [`Test Lead ${i}`, 'Test', `Lead${i}`, `lead${i}@demo.example`, `+9198000100${String(i).padStart(2, '0')}`, i % 2 === 0 ? 'Male' : 'Female', newStage?.id, counsellor?.id]);
  }

  logger.info({ slug }, 'dev seed complete');
};

main().then(closeSystemPool).catch(async (err) => { logger.fatal({ err: err.message }, 'seed failed'); await closeSystemPool(); process.exit(1); });
