// Read-only: which WhatsApp keys are SET per tenant. Prints presence/length
// and only non-secret values (phone, enabled) — never the keys themselves.
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';
const mask = (v) => (v ? `SET (${String(v).length} chars)` : '— empty —');
const { rows: ts } = await sysQuery(`SELECT * FROM tenants WHERE deleted_at IS NULL AND status='active' ORDER BY slug`);
for (const t of ts) {
  console.log(`\n=== ${t.slug} ===`);
  try {
    const { rows } = await tenantQuery(t, `SELECT * FROM wa_settings WHERE id = true`);
    const r = rows[0];
    if (!r) { console.log('  no wa_settings row'); continue; }
    for (const k of Object.keys(r)) {
      if (k === 'id') continue;
      const v = r[k];
      // business_phone / enabled / timestamps are not secrets.
      if (['enabled','business_phone','created_at','updated_at'].includes(k)) {
        console.log(`  ${k.padEnd(24)} ${v instanceof Date ? v.toISOString().slice(0,19) : String(v ?? '—')}`);
      } else {
        console.log(`  ${k.padEnd(24)} ${mask(v)}`);
      }
    }
  } catch (e) { console.log('  ERROR:', e.message.slice(0,70)); }
}
await closeSystemPool();
