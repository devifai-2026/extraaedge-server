import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import migrationRunner from 'node-pg-migrate';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { DEFAULT_BUSINESS_HOURS, DEFAULT_TAB_KEYS, CALL_DISPOSITIONS } from '../config/constants.js';

const { Client } = pg;

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const tenantMigrationsDir = path.resolve(thisDir, '../db/migrations/tenant');

const superuserConfig = (databaseOverride) => ({
  host: env.TENANT_DB_HOST,
  port: env.TENANT_DB_PORT,
  database: databaseOverride ?? 'postgres',
  user: env.TENANT_DB_SUPERUSER,
  password: env.TENANT_DB_SUPERUSER_PASSWORD,
  ssl: env.TENANT_DB_SSL ? { rejectUnauthorized: false } : false,
});

// Runs CREATE ROLE + CREATE DATABASE + GRANTs as the Postgres superuser.
const createDatabaseAndRole = async ({ db_name, db_user, db_password }) => {
  const admin = new Client(superuserConfig());
  await admin.connect();
  try {
    const roleExists = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [db_user]);
    if (roleExists.rowCount === 0) {
      // Password interpolation allowed here: db_user/db_password are system-generated, never user input.
      await admin.query(`CREATE ROLE "${db_user}" LOGIN PASSWORD '${db_password.replace(/'/g, "''")}'`);
    } else {
      await admin.query(`ALTER ROLE "${db_user}" WITH PASSWORD '${db_password.replace(/'/g, "''")}'`);
    }
    // Cloud SQL: superuser must be a member of the owner role to CREATE DATABASE OWNER.
    await admin.query(`GRANT "${db_user}" TO CURRENT_USER`);
    const dbExists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [db_name]);
    if (dbExists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${db_name}" OWNER "${db_user}" ENCODING 'UTF8'`);
    }
  } finally {
    await admin.end();
  }
};

const applyMigrations = async ({ db_name, db_user, db_password }) => {
  await migrationRunner({
    databaseUrl: {
      host: env.TENANT_DB_HOST,
      port: env.TENANT_DB_PORT,
      database: db_name,
      user: db_user,
      password: db_password,
      ssl: env.TENANT_DB_SSL ? { rejectUnauthorized: false } : false,
    },
    dir: tenantMigrationsDir,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: (msg) => logger.info(`[tenant-migrate ${db_name}] ${msg}`),
    verbose: false,
  });
};

const seedTenantDefaults = async ({ tenant, first_admin, db_password }) => {
  const client = new Client({
    host: env.TENANT_DB_HOST,
    port: env.TENANT_DB_PORT,
    database: tenant.db_name,
    user: tenant.db_user,
    password: db_password,
    ssl: env.TENANT_DB_SSL ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    await client.query('BEGIN');

    // Default custom roles with tab permissions
    const roleBundles = [
      { name: 'super_admin', description: 'Tenant owner — full access', scope: 'super_admin', is_system: true, tab_permissions: Object.fromEntries(DEFAULT_TAB_KEYS.map((t) => [t, 'full'])) },
      { name: 'sales_manager', description: 'Manages a team of counsellors', scope: 'sales_manager', is_system: true, tab_permissions: Object.fromEntries(DEFAULT_TAB_KEYS.filter((t) => !t.startsWith('advanced.') && t !== 'third_party_integration').map((t) => [t, 'full'])) },
      { name: 'counsellor', description: 'Handles assigned leads', scope: 'counsellor', is_system: true, tab_permissions: {
        dashboard: 'full', leads: 'full', raw_data: 'read_only', failed_leads: 'read_only',
        followups: 'full', whatsapp: 'full', bulk_upload: 'full',
        'settings.email_templates': 'read_only', 'settings.sms_templates': 'read_only',
      } },
    ];
    const roleIds = {};
    for (const r of roleBundles) {
      const { rows } = await client.query(
        `INSERT INTO custom_roles (name, description, scope, is_system, tab_permissions)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [r.name, r.description, r.scope, r.is_system, r.tab_permissions],
      );
      roleIds[r.name] = rows[0].id;
    }

    // Default lead stages
    const stages = [
      { name: 'New', code: '01-New', order_index: 1, color: '#1976D2', is_terminal: false },
      { name: 'Contacted', code: '02-Contacted', order_index: 2, color: '#7B1FA2', is_terminal: false },
      { name: 'Followup', code: '03-Followup', order_index: 3, color: '#F57C00', is_terminal: false },
      { name: 'Qualified', code: '05-Qualified', order_index: 4, color: '#388E3C', is_terminal: false },
      { name: 'Requirement Match', code: '07-Requirement-Match', order_index: 5, color: '#00838F', is_terminal: false },
      { name: 'Interested', code: '08-Interested', order_index: 6, color: '#2E7D32', is_terminal: false },
      { name: 'Visited', code: '09-Visited', order_index: 7, color: '#1565C0', is_terminal: false },
      { name: 'Enrolled', code: '10-Enrolled', order_index: 8, color: '#2E7D32', is_terminal: true },
      { name: 'Junk', code: '11-Junk', order_index: 9, color: '#757575', is_terminal: true },
      { name: 'Cold', code: '12-Cold', order_index: 10, color: '#546E7A', is_terminal: true },
    ];
    for (const s of stages) {
      await client.query(
        `INSERT INTO lead_stages (name, code, order_index, color, is_terminal) VALUES ($1,$2,$3,$4,$5)`,
        [s.name, s.code, s.order_index, s.color, s.is_terminal],
      );
    }

    // Default sub-stages (one "Default" sub-stage per stage — tenants extend later)
    const subStages = ['Not Called', 'Awaiting confirmation', 'Will join soon', 'Negotiation phase', 'Needs demo', 'Not Eligible', 'Not Interested', 'Asked to call back'];
    for (const ss of subStages) {
      await client.query(
        `INSERT INTO lead_sub_stages (stage_id, name, is_default)
         SELECT id, $1, false FROM lead_stages WHERE code = '01-New'`,
        [ss],
      );
    }

    // Dropdown dictionaries
    const channels = ['Offline', 'Online', 'Direct', 'Facebook', 'Google Ads', 'LinkedIn', 'Email Campaign'];
    for (const c of channels) await client.query(`INSERT INTO lead_channels (name) VALUES ($1)`, [c]);
    const sources = ['Direct Walk-in', 'Website', 'Social Media', 'Professional Network', 'Newsletter', 'Referral'];
    for (const s of sources) await client.query(`INSERT INTO lead_sources_dict (name) VALUES ($1)`, [s]);
    const campaignNames = ['Web Add Lead', 'ORGANIC', 'PAID'];
    for (const c of campaignNames) await client.query(`INSERT INTO lead_campaigns_dict (name) VALUES ($1)`, [c]);
    const mediums = ['Free', 'CPC', 'Referral', 'Email'];
    for (const m of mediums) await client.query(`INSERT INTO lead_mediums (name) VALUES ($1)`, [m]);
    const genders = ['Male', 'Female', 'Other'];
    for (const g of genders) await client.query(`INSERT INTO genders (name) VALUES ($1)`, [g]);

    // Business hours
    for (const bh of DEFAULT_BUSINESS_HOURS) {
      await client.query(
        `INSERT INTO business_hours (day_of_week, is_open, open_time, close_time, timezone)
         VALUES ($1,$2,$3,$4,$5)`,
        [bh.day_of_week, bh.is_open, bh.open_time, bh.close_time, tenant.timezone ?? 'Asia/Kolkata'],
      );
    }

    // Call dispositions
    for (const d of Object.values(CALL_DISPOSITIONS)) {
      await client.query(
        `INSERT INTO call_dispositions (code, label, category, requires_callback, auto_create_followup_hours, is_active, order_index)
         VALUES ($1,$2,$3,$4,$5,true, 0)`,
        [d.code, d.label, d.category, d.requires_callback, d.auto_followup_hours ?? null],
      );
    }

    // First admin user
    await client.query(
      `INSERT INTO users (email, phone, name, password_hash, role_id, role, is_active, track_work_time, session_timeout_minutes)
       VALUES ($1,$2,$3,$4,$5,'super_admin',true,false,15)`,
      [first_admin.email, first_admin.phone ?? null, first_admin.name, first_admin.password_hash, roleIds.super_admin],
    );

    // Seed every tenant with one rule per strategy. Only `round_robin` is
    // active by default; admins activate whichever fits their org from
    // Settings → Assignment Rules. Backend enforces max 1 active rule per
    // tenant via the assignment-rules service.
    const seedRules = [
      { name: 'Round Robin',        strategy: 'round_robin',      priority: 100, is_active: true  },
      { name: 'Load Balanced',      strategy: 'load_balanced',    priority: 200, is_active: false },
      { name: 'By Program',         strategy: 'by_program',       priority: 300, is_active: false },
      { name: 'By Geography',       strategy: 'by_geography',     priority: 400, is_active: false },
      { name: 'Specific User',      strategy: 'specific_user',    priority: 500, is_active: false },
      { name: 'Team Round Robin',   strategy: 'team_round_robin', priority: 600, is_active: false },
    ];
    for (const r of seedRules) {
      const { rows } = await client.query(
        `INSERT INTO assignment_rules (name, priority, condition_json, strategy, is_active)
         VALUES ($1, $2, '{}'::jsonb, $3, $4)
         RETURNING id`,
        [r.name, r.priority, r.strategy, r.is_active],
      );
      await client.query(
        `INSERT INTO assignment_rule_state (rule_id, last_assigned_user_id, total_assignments)
         VALUES ($1, NULL, 0) ON CONFLICT (rule_id) DO NOTHING`,
        [rows[0].id],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
};

export const provisionTenantDatabase = async ({ tenant, db_password, first_admin }) => {
  await createDatabaseAndRole({ db_name: tenant.db_name, db_user: tenant.db_user, db_password });
  await applyMigrations({ db_name: tenant.db_name, db_user: tenant.db_user, db_password });
  await seedTenantDefaults({ tenant, first_admin, db_password });
};

// Used by scripts/run-migrations.js --target tenant to fan out new migrations across existing tenant DBs.
export const migrateTenant = async ({ tenant, db_password }) => {
  await applyMigrations({ db_name: tenant.db_name, db_user: tenant.db_user, db_password });
};
