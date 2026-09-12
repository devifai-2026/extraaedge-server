// E2E: the full business journey on the demo tenant, the way a real team works
// it — lead in, worked, converted, taught, placed.
//
// Each step goes through the REAL API as the role that would actually do it,
// so a broken permission or scope fails the step rather than passing silently.
// Read-mostly: the one write (a lead + its progression) is cleaned up at the end.
import 'dotenv/config';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { closeSystemPool } from '../src/db/system.js';
import { signAccessToken } from '../src/lib/jwt.js';

const BASE = 'http://localhost:4001/api/v1';
const t = await resolveTenantBySlug('demo');
let fail = 0;
const step = (n, ok, msg) => { if (!ok) fail += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}. ${msg}`); };

const user = async (email) => {
  const { rows: [u] } = await tenantQuery(t, `SELECT id, role, name FROM users WHERE email=$1 AND deleted_at IS NULL`, [email]);
  if (!u) throw new Error(`missing seeded user ${email}`);
  return u;
};
const as = (u) => signAccessToken({ sub: u.id, tenantId: t.id, tenantSlug: 'demo', role: u.role, sessionId: 'journey', type: 'access' });
const api = async (u, path, opt = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    ...opt,
    headers: { authorization: `Bearer ${as(u)}`, 'content-type': 'application/json', ...(opt.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data, error: j?.error };
};

const admin = await user('admin@demo.local').catch(async () => {
  const { rows: [u] } = await tenantQuery(t, `SELECT id, role, name FROM users WHERE role='super_admin' AND deleted_at IS NULL LIMIT 1`);
  return u;
});
const sm = await user('sm@demo.local');
const counsellor = await user('counsellor@demo.local');
const trainer = await user('trainer@demo.local');
const placement = await user('placement@demo.local');
const hr = await user('hr@demo.local');
const accounts = await user('accounts@demo.local');

console.log('\n=== FULL BUSINESS JOURNEY (demo) ===\n');

// 1. A lead arrives and is assigned to a counsellor.
await tenantQuery(t, `DELETE FROM leads WHERE phone='+919999000111'`);
const { rows: [stage] } = await tenantQuery(t, `SELECT id FROM lead_stages WHERE is_active AND deleted_at IS NULL ORDER BY order_index LIMIT 1`);
const { rows: [lead] } = await tenantQuery(t,
  `INSERT INTO leads (name, phone, email, stage_id, assigned_to, first_touch_source, last_activity_at)
   VALUES ('Journey Candidate','+919999000111','journey@demo.local',$1,$2,'Website', now()) RETURNING id`,
  [stage.id, counsellor.id]);
step(1, !!lead.id, 'lead created and assigned to the counsellor');

// 2. The counsellor sees it in their own queue.
const myLeads = await api(counsellor, '/leads?limit=200');
step(2, myLeads.status === 200 && (myLeads.data || []).some((l) => l.id === lead.id),
  'counsellor sees the lead in their scoped queue');

// 3. Their manager sees it too, via the team hierarchy.
const smLeads = await api(sm, '/leads?limit=200');
step(3, smLeads.status === 200 && (smLeads.data || []).some((l) => l.id === lead.id),
  'sales manager sees it through the team hierarchy');

// 4. The counsellor books a follow-up — which auto-moves the stage off New.
const fu = await api(counsellor, '/follow-ups', {
  method: 'POST',
  body: JSON.stringify({ lead_id: lead.id, next_action_datetime: new Date(Date.now() + 864e5).toISOString(), notes: 'journey test' }),
});
const { rows: [moved] } = await tenantQuery(t, `SELECT s.name FROM leads l JOIN lead_stages s ON s.id=l.stage_id WHERE l.id=$1`, [lead.id]);
step(4, fu.status < 400 && moved.name !== 'New', `follow-up booked and stage auto-moved to "${moved.name}"`);

// 5. Overdue/today counters reflect the counsellor's own work.
const summary = await api(counsellor, '/analytics/summary');
step(5, summary.status === 200 && typeof summary.data?.followups_overdue === 'number',
  `dashboard reports due_today=${summary.data?.followups_due_today} overdue=${summary.data?.followups_overdue}`);

// 6. Accounts can reach the admissions pipeline.
const adms = await api(accounts, '/admissions?limit=5');
step(6, adms.status === 200, `accounts sees ${(adms.data || []).length} admission(s)`);

// 7. A trainer has a course, a batch and a taught class.
const courses = await api(trainer, '/courses');
const classes = await api(trainer, '/classes?limit=20');
step(7, courses.status === 200 && (courses.data || []).length > 0 && (classes.data || []).length > 0,
  `trainer has ${(courses.data || []).length} course(s) and ${(classes.data || []).length} class(es)`);

// 8. Attendance was actually recorded against those classes.
const { rows: [att] } = await tenantQuery(t,
  `SELECT count(*)::int c, count(*) FILTER (WHERE status='present')::int present FROM attendance`);
step(8, att.c > 0, `attendance has ${att.c} row(s), ${att.present} present`);

// 9. A batch merge is represented, not just assumed.
const { rows: [mg] } = await tenantQuery(t,
  `SELECT count(*)::int c FROM batches WHERE merged_into_batch_id IS NOT NULL AND deleted_at IS NULL`);
step(9, mg.c > 0, `${mg.c} batch(es) merged into another`);

// 10. Placement has companies, live openings and student applications.
const openings = await api(placement, '/placement/openings');
const { rows: [apps] } = await tenantQuery(t, `SELECT count(*)::int c FROM job_applications`);
step(10, openings.status === 200 && (openings.data || []).length > 0 && apps.c > 0,
  `placement sees ${(openings.data || []).length} opening(s), ${apps.c} application(s) in the pipeline`);

// 11. HR reaches its own surfaces and sees NO lead or staff data.
//
// Note the lead list returns 200 with ZERO rows rather than 403: computeScope
// falls through to { user_ids: [actor.id] } for any role outside the manager /
// owner sets, so HR is scoped to leads it owns — which is none. That is the
// safe default doing its job; asserting 403 here was wrong. The hard refusals
// are on admissions and the user list.
const hrCounts = await api(hr, '/learning/hr/counts');
const hrLeads = await api(hr, '/leads?limit=5');
const hrAdms = await api(hr, '/admissions?limit=5');
step(11, hrCounts.status === 200
  && hrLeads.status === 200 && (hrLeads.data || []).length === 0
  && hrAdms.status === 403,
  'HR reaches its dashboard, sees 0 leads (scoped to none) and is refused admissions');

// 12. The stale rule shows the owner their own at-risk leads.
const stale = await api(counsellor, '/sla-policies/handovers?view=upcoming&limit=100');
const owners = new Set((stale.data || []).map((r) => r.from_user_id));
step(12, stale.status === 200 && (owners.size === 0 || (owners.size === 1 && owners.has(counsellor.id))),
  `counsellor sees ${(stale.data || []).length} upcoming stale lead(s), strictly their own`);

// 13. A student can see their own attendance calendar.
const { rows: [stu] } = await tenantQuery(t, `SELECT id FROM students WHERE email LIKE 'student%@demo.local' AND deleted_at IS NULL LIMIT 1`);
const { rows: [stuAtt] } = await tenantQuery(t, `SELECT count(*)::int c FROM attendance WHERE student_id=$1`, [stu.id]);
step(13, stuAtt.c > 0, `a seeded student has ${stuAtt.c} attendance record(s) to display`);

// ---- cleanup ---------------------------------------------------------------
await tenantQuery(t, `DELETE FROM lead_followups WHERE lead_id=$1`, [lead.id]);
await tenantQuery(t, `DELETE FROM lead_activities WHERE lead_id=$1`, [lead.id]);
await tenantQuery(t, `DELETE FROM lead_assignments WHERE lead_id=$1`, [lead.id]);
await tenantQuery(t, `DELETE FROM leads WHERE id=$1`, [lead.id]);

console.log(`\n${fail === 0 ? 'ALL 13 STEPS PASSED' : fail + ' STEP(S) FAILED'} — journey lead cleaned up\n`);
await closeAllTenantPools(); await closeSystemPool();
process.exit(fail ? 1 : 0);
