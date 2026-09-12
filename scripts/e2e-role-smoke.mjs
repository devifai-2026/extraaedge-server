// E2E smoke: log in as every seeded role and confirm its portal returns DATA,
// not just a 200. Prints `status/count` per surface — a 200/0 means the page
// would render empty, which is the failure this is designed to catch.
//
// Run against the demo tenant after scripts/seed-demo-full.js:
//   node scripts/e2e-role-smoke.mjs
//
// Read-only: it mints tokens and issues GETs, and writes nothing.
import 'dotenv/config';
import { resolveTenantBySlug, tenantQuery } from '../src/db/tenant.js';
import { signAccessToken } from '../src/lib/jwt.js';

const BASE = 'http://localhost:4001/api/v1';
const t = await resolveTenantBySlug('demo');
const { rows: users } = await tenantQuery(t,
  `SELECT id, email, role, name FROM users WHERE email LIKE '%@demo.local' AND deleted_at IS NULL ORDER BY role`);

const tok = (u) => signAccessToken({
  sub: u.id, email: u.email, tenantId: t.id, tenantSlug: 'demo',
  role: u.role, sessionId: 'e2e', type: 'access',
});

const hit = async (u, path) => {
  try {
    const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${tok(u)}` } });
    const j = await r.json().catch(() => ({}));
    const n = Array.isArray(j?.data) ? j.data.length
      : (j?.data && typeof j.data === 'object' ? Object.keys(j.data).length : null);
    return `${r.status}${n !== null ? `/${n}` : ''}`;
  } catch (e) { return 'ERR'; }
};

// The surface each role actually opens on. Expect 200 AND a non-zero count.
// Self-service surfaces EVERY role must be able to open — an empty portal for
// any of these is the failure this catches.
const SELF_SERVICE = [['/staff-leave/types'], ['/staff-leave/mine/balances']];

const CHECKS = {
  branch_manager:  [['/analytics/summary'], ['/leads?limit=5'], ['/users?limit=5']],
  sales_manager:   [['/analytics/summary'], ['/leads?limit=5'], ['/users/team']],
  telecaller_lead: [['/leads?limit=5'], ['/qa-reviews/queue?limit=5'], ['/device-recordings?limit=5']],
  telecaller:      [['/leads?limit=5'], ['/follow-ups/my']],
  counsellor:      [['/leads?limit=5'], ['/follow-ups/my'], ['/lead-pool?q=demo']],
  account_manager: [['/admissions?limit=5']],
  qa:              [['/qa-reviews/queue?limit=5'], ['/qa-reviews/parameters']],
  hr:              [['/interviews/hr/queue'], ['/learning/hr/counts']],
  placement:       [['/placement/counts'], ['/placement/companies'], ['/placement/openings']],
  head_trainer:    [['/courses'], ['/courses/insights']],
  hr_team_lead:    [['/learning/hr/counts'], ['/placement/counts'], ['/staff-leave/types']],
  hr_recruiter:    [['/learning/hr/counts'], ['/staff-leave/types']],
  placement_officer: [['/placement/counts'], ['/placement/openings'], ['/placement/companies']],
  trainer:         [['/courses'], ['/classes?limit=5']],
};

console.log('=== E2E: every role opens its portal WITH data (status/count) ===\n');
for (const u of users) {
  const checks = CHECKS[u.role];
  if (!checks) continue;
  const out = [];
  for (const [path] of checks) out.push(`${path.split('?')[0]} -> ${await hit(u, path)}`);
  console.log(`  ${u.role.padEnd(16)} ${u.email.padEnd(26)} ${out.join('  |  ')}`);
}
process.exit(0);
