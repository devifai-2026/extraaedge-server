// One-time branch backfill for tenants that won't go through the admin wizard.
//
// Usage:
//   node scripts/backfill-branches.js
//     → per tenant: if it has >=1 branch, stamp every branch-less lead with the
//       tenant's oldest branch. If it has 0 branches, SKIP (we can't invent a
//       branch manager non-interactively) and log that it needs the wizard.
//
//   node scripts/backfill-branches.js --default-branch="Main Branch"
//     → for tenants with 0 branches, also create a headless default branch,
//       adopt all non-super_admin users into it, and stamp all leads into it.
//
//   node scripts/backfill-branches.js --slug=demo [...]
//     → restrict to a single tenant.
//
// Idempotent: only touches NULL branch_id rows; existing branches untouched.
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery, tenantTx } from '../src/db/tenant.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v = true]) => [k, v]),
);
const defaultBranchName = typeof args['default-branch'] === 'string' ? args['default-branch'] : null;

let q = `SELECT id, slug, status, db_name, db_user, db_password_encrypted FROM tenants WHERE deleted_at IS NULL`;
const params = [];
if (args.slug) { params.push(args.slug); q += ` AND slug = $${params.length}`; }
const { rows: tenants } = await sysQuery(q, params);

for (const tenant of tenants) {
  // Oldest live branch for this tenant (the one we backfill leads into).
  const { rows: branches } = await tenantQuery(
    tenant,
    `SELECT id FROM branches WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  );
  let branchId = branches[0]?.id ?? null;

  if (!branchId) {
    if (!defaultBranchName) {
      console.log(`[${tenant.slug}] 0 branches — SKIPPED (run the admin wizard, or pass --default-branch)`);
      continue;
    }
    // Create a headless default branch + adopt everyone in one transaction.
    const out = await tenantTx(tenant, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO branches (name, is_active) VALUES ($1, true) RETURNING id`,
        [defaultBranchName],
      );
      const id = rows[0].id;
      const u = await client.query(
        `UPDATE users SET branch_id = $1 WHERE branch_id IS NULL AND deleted_at IS NULL AND role <> 'super_admin'`,
        [id],
      );
      const l = await client.query(
        `UPDATE leads SET branch_id = $1 WHERE branch_id IS NULL AND deleted_at IS NULL`,
        [id],
      );
      return { id, users: u.rowCount, leads: l.rowCount };
    });
    console.log(`[${tenant.slug}] created '${defaultBranchName}', adopted ${out.users} users, ${out.leads} leads`);
    continue;
  }

  // Branch already exists — just stamp branch-less leads into the oldest one.
  const r = await tenantQuery(
    tenant,
    `UPDATE leads SET branch_id = $1 WHERE branch_id IS NULL AND deleted_at IS NULL RETURNING id`,
    [branchId],
  );
  console.log(`[${tenant.slug}] stamped ${r.rows.length} branch-less leads into existing branch`);
}

await closeSystemPool();
