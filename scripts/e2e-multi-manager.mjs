// E2E: multi-manager visibility, on the demo tenant.
//
// Proves the "reporting manager can be any 1 or any 2 people" rule actually
// delivers DATA to the second manager — the thing that was cosmetic before.
// Grants a temporary second manager, checks the lead list through the real API,
// then removes it.
import 'dotenv/config';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { closeSystemPool } from '../src/db/system.js';
import { signAccessToken } from '../src/lib/jwt.js';

const BASE = 'http://localhost:4001/api/v1';
const t = await resolveTenantBySlug('demo');
let failures = 0;
const expect = (c, m) => { if (!c) failures += 1; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); };

const tok = (u) => signAccessToken({ sub: u.id, tenantId: t.id, tenantSlug: 'demo', role: u.role, sessionId: 'e2e', type: 'access' });
const leadCount = async (u) => {
  const r = await fetch(`${BASE}/leads?limit=200`, { headers: { authorization: `Bearer ${tok(u)}` } });
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j?.data) ? j.data.length : -1;
};

// The second manager: a sales manager who does NOT primarily manage the telecaller.
const { rows: [second] } = await tenantQuery(t, `SELECT id, name, role FROM users WHERE email='manager@demo.local'`);
const { rows: [report] } = await tenantQuery(t, `SELECT id, name, role, manager_id FROM users WHERE email='telecaller@demo.local'`);
const { rows: [{ c: reportLeads }] } = await tenantQuery(t,
  `SELECT count(*) c FROM leads WHERE assigned_to=$1 AND deleted_at IS NULL`, [report.id]);

console.log(`\n  ${report.name} owns ${reportLeads} leads; primary manager is NOT ${second.name}\n`);

const before = await leadCount(second);
expect(before >= 0, `baseline: ${second.name} sees ${before} leads`);

// --- grant the SECOND reporting line (primary untouched) -------------------
await tenantQuery(t, `INSERT INTO user_managers (user_id, manager_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [report.id, second.id]);
const { rows: [chk] } = await tenantQuery(t, `SELECT manager_id FROM users WHERE id=$1`, [report.id]);
expect(chk.manager_id === report.manager_id, 'primary manager_id is unchanged (only a SECOND line was added)');

const after = await leadCount(second);
expect(after > before, `second manager now sees more leads (${before} -> ${after})`);

// the report's own leads must be inside that set
const r2 = await fetch(`${BASE}/leads?limit=200`, { headers: { authorization: `Bearer ${tok(second)}` } });
const j2 = await r2.json();
const mine = (j2.data || []).filter((l) => l.assigned_to === report.id).length;
expect(mine > 0, `the second manager can see ${mine} of the report's own leads`);

// --- remove it and confirm the visibility goes away ------------------------
await tenantQuery(t, `DELETE FROM user_managers WHERE user_id=$1 AND manager_id=$2`, [report.id, second.id]);
const restored = await leadCount(second);
expect(restored === before, `removing the second line restores the original scope (${restored} = ${before})`);

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}\n`);
await closeAllTenantPools(); await closeSystemPool();
process.exit(failures ? 1 : 0);
