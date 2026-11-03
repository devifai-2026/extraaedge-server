import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';
const { rows: ts } = await sysQuery(`SELECT * FROM tenants WHERE deleted_at IS NULL AND slug IN ('speedup-infotech','si-hr') ORDER BY slug DESC`);
for (const t of ts) {
  console.log(`\n=== ${t.slug} ===`);
  for (const tbl of ['fb_settings','fb_ad_accounts','integrations','payment_accounts']) {
    try {
      const { rows } = await tenantQuery(t, `SELECT count(*)::int n FROM ${tbl}`);
      console.log(`  ${tbl.padEnd(18)} ${rows[0].n} row(s)`);
    } catch(e){ console.log(`  ${tbl.padEnd(18)} err`); }
  }
  // integrations detail (type only, no secrets)
  try {
    const { rows } = await tenantQuery(t, `SELECT type, name, is_active FROM integrations`);
    for (const r of rows) console.log(`     -> integration: ${r.type} "${r.name}" active=${r.is_active}`);
  } catch {}
  try {
    const { rows } = await tenantQuery(t, `SELECT (page_access_token IS NOT NULL) AS tok, (app_secret IS NOT NULL) AS sec FROM fb_settings LIMIT 1`);
    if (rows[0]) console.log(`     -> fb_settings: page_token=${rows[0].tok} app_secret=${rows[0].sec}`);
  } catch(e){ console.log('     -> fb_settings cols differ'); }
}
await closeSystemPool();
