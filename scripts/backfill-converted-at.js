// Stamp leads.converted_at = now() for any lead currently in a success stage
// that doesn't yet have a converted_at value.
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';

const { rows: tenants } = await sysQuery(`SELECT id, slug, status, db_name, db_user, db_password_encrypted FROM tenants WHERE deleted_at IS NULL`);
for (const tenant of tenants) {
  const r = await tenantQuery(tenant, `
    UPDATE leads l
       SET converted_at = now()
      FROM lead_stages s
     WHERE l.stage_id = s.id
       AND s.is_success = true
       AND l.converted_at IS NULL
       AND l.deleted_at IS NULL
    RETURNING l.id
  `);
  console.log(`[${tenant.slug}] backfilled converted_at on ${r.rows.length} leads`);
}
await closeSystemPool();
