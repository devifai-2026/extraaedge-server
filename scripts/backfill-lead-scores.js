// One-shot: recompute lead_score from current stage_id / sub_stage_id scores.
// Run: node scripts/backfill-lead-scores.js [--slug=demo]
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';
const logger = { info: (m) => console.log(m), fatal: (...a) => console.error(...a) };

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const main = async () => {
  let q = `SELECT id, slug, status, db_name, db_user, db_password_encrypted FROM tenants WHERE deleted_at IS NULL`;
  const params = [];
  if (args.slug) { params.push(args.slug); q += ` AND slug = $${params.length}`; }
  const { rows: tenants } = await sysQuery(q, params);

  for (const tenant of tenants) {
    const r = await tenantQuery(tenant, `
      UPDATE leads l
         SET lead_score = COALESCE((SELECT score FROM lead_stages WHERE id = l.stage_id), 0)
                        + COALESCE((SELECT score FROM lead_sub_stages WHERE id = l.sub_stage_id), 0)
       WHERE l.deleted_at IS NULL
       RETURNING id
    `);
    logger.info(`[${tenant.slug}] backfilled lead_score on ${r.rows.length} leads`);
  }
  await closeSystemPool();
};

main().catch((e) => { logger.fatal({ err: e }, 'backfill failed'); process.exit(1); });
