// Full-coverage demo seed — one user per role, students across every lifecycle
// state, and leads spread over the real pipeline so EVERY portal opens with
// data instead of an empty table.
//
// Why this exists: the HR / Trainer / Placement portals looked empty not because
// the pages were broken but because the demo tenant had no rows for them — no
// hr user, no placement user, no qa user, two students total. An empty screen
// reads as "this feature is missing", which is the worst possible first
// impression of a working module.
//
// SAFE TO RE-RUN. Every insert is guarded (ON CONFLICT DO NOTHING, or a
// NOT EXISTS guard), so running it twice adds nothing and changes nothing.
// It never deletes and never overwrites a row a human may have edited.
//
//   node scripts/seed-demo-full.js --slug=demo
//
// Login for every seeded user: ChangeMe123!
import argon2 from 'argon2';
import { closeSystemPool } from '../src/db/system.js';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { logger } from '../src/lib/logger.js';

const parseArgs = () => Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')),
);

const PASSWORD = 'ChangeMe123!';

// One user per role, so every portal has somebody to log in as. Emails follow
// <role>@demo.local so they are obvious in a user list and can't collide with
// a real address.
const STAFF = [
  { role: 'branch_manager',  name: 'Bina Branch',      email: 'bm@demo.local',          phone: '+919810000001' },
  { role: 'sales_manager',   name: 'Sameer Sales',     email: 'sm@demo.local',          phone: '+919810000002' },
  { role: 'telecaller_lead', name: 'Tara Telelead',    email: 'tl@demo.local',          phone: '+919810000003' },
  { role: 'telecaller',      name: 'Tanvi Telecaller', email: 'telecaller@demo.local',  phone: '+919810000004' },
  { role: 'counsellor',      name: 'Chetan Counsellor', email: 'counsellor@demo.local', phone: '+919810000005' },
  { role: 'account_manager', name: 'Anita Accounts',   email: 'accounts@demo.local',    phone: '+919810000006' },
  { role: 'qa',              name: 'Qadir Quality',    email: 'qa@demo.local',          phone: '+919810000007' },
  { role: 'hr',              name: 'Hema HR',          email: 'hr@demo.local',          phone: '+919810000008' },
  { role: 'placement',       name: 'Prakash Placement', email: 'placement@demo.local',  phone: '+919810000009' },
  { role: 'head_trainer',    name: 'Harsh HeadTrainer', email: 'headtrainer@demo.local', phone: '+919810000010' },
  { role: 'trainer',         name: 'Tina Trainer',     email: 'trainer@demo.local',     phone: '+919810000011' },
];

// Students across every status the LMS understands, so drop-candidate and
// on-break screens are populated too, not just the happy path.
const STUDENT_STATUSES = ['active', 'active', 'active', 'active', 'on_break', 'dropped'];

const main = async () => {
  const args = parseArgs();
  const slug = args.slug ?? 'demo';
  const tenant = await resolveTenantBySlug(slug);
  if (!tenant) throw new Error(`Tenant not found: ${slug}`);

  const summary = {};
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1,
  });

  // ---- roles + branch -----------------------------------------------------
  const { rows: roleRows } = await tenantQuery(
    tenant,
    `SELECT id, scope FROM custom_roles WHERE deleted_at IS NULL`,
  );
  const roleId = Object.fromEntries(roleRows.map((r) => [r.scope, r.id]));

  const { rows: [branch] } = await tenantQuery(
    tenant,
    `SELECT id FROM branches WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  );
  const branchId = branch?.id ?? null;

  const { rows: [admin] } = await tenantQuery(
    tenant,
    `SELECT id FROM users WHERE role = 'super_admin' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  );

  // ---- 1. staff -----------------------------------------------------------
  // Reporting lines are set in a second pass so a manager always exists before
  // anyone points at them.
  let created = 0;
  for (const s of STAFF) {
    if (!roleId[s.role]) { logger.warn(`skip ${s.role} — role not seeded in this tenant`); continue; }
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO users (name, email, phone, password_hash, role, role_id, branch_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [s.name, s.email, s.phone, hash, s.role, roleId[s.role], s.role === 'super_admin' ? null : branchId],
    );
    if (rows[0]) created += 1;
  }
  summary.staff_created = created;

  const { rows: staffRows } = await tenantQuery(
    tenant,
    `SELECT id, email, role FROM users WHERE email = ANY($1::text[]) AND deleted_at IS NULL`,
    [STAFF.map((s) => s.email)],
  );
  const byEmail = Object.fromEntries(staffRows.map((r) => [r.email, r]));

  // ---- 2. reporting lines -------------------------------------------------
  // Mirrors the client's org chart: everyone under the BM, front line under
  // their own lead. Only fills a BLANK manager so a hand-edited line survives.
  const reports = [
    ['bm@demo.local', admin?.id],
    ['sm@demo.local', byEmail['bm@demo.local']?.id],
    ['counsellor@demo.local', byEmail['sm@demo.local']?.id],
    ['telecaller@demo.local', byEmail['tl@demo.local']?.id],
    // The telecaller lead reports to the sales manager, so the SM's subtree
    // reaches the telecalling line too — otherwise an SM opens an empty lead
    // list, which is exactly the "portal looks empty" complaint.
    ['tl@demo.local', byEmail['sm@demo.local']?.id],
    ['accounts@demo.local', byEmail['bm@demo.local']?.id],
    ['qa@demo.local', byEmail['bm@demo.local']?.id],
    ['hr@demo.local', byEmail['bm@demo.local']?.id],
    ['placement@demo.local', byEmail['bm@demo.local']?.id],
    ['headtrainer@demo.local', byEmail['bm@demo.local']?.id],
    ['trainer@demo.local', byEmail['headtrainer@demo.local']?.id],
  ];
  let linked = 0;
  for (const [email, managerId] of reports) {
    const u = byEmail[email];
    if (!u || !managerId) continue;
    const { rows } = await tenantQuery(
      tenant,
      `UPDATE users SET manager_id = $2 WHERE id = $1 AND manager_id IS NULL RETURNING id`,
      [u.id, managerId],
    );
    await tenantQuery(
      tenant,
      `INSERT INTO user_managers (user_id, manager_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [u.id, managerId],
    );
    if (rows[0]) linked += 1;
  }
  summary.reporting_lines_set = linked;

  // ---- 3. trainer -> course binding --------------------------------------
  // Without this the Trainer portal has no course to show, which is the main
  // reason it looked empty.
  const { rows: programs } = await tenantQuery(
    tenant,
    `SELECT id, name FROM programs WHERE deleted_at IS NULL ORDER BY created_at LIMIT 3`,
  );
  let bound = 0;
  for (const [email, kind] of [['headtrainer@demo.local', 'head'], ['trainer@demo.local', 'trainer']]) {
    const u = byEmail[email];
    if (!u) continue;
    for (const prog of programs.slice(0, kind === 'head' ? 3 : 2)) {
      const { rows } = await tenantQuery(
        tenant,
        `INSERT INTO course_trainers (program_id, user_id, role, created_by)
         SELECT $1, $2, $3, $4
          WHERE NOT EXISTS (
            SELECT 1 FROM course_trainers
             WHERE program_id = $1 AND user_id = $2 AND deleted_at IS NULL
          )
         RETURNING id`,
        [prog.id, u.id, kind, admin?.id ?? null],
      );
      if (rows[0]) bound += 1;
    }
  }
  summary.course_trainer_bindings = bound;

  // ---- 4. batches ---------------------------------------------------------
  let batches = 0;
  const batchIds = [];
  for (const prog of programs) {
    const name = `${prog.name.split(' ').slice(0, 2).join(' ')} — Batch A`;
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO batches (program_id, name, start_date, status, created_by)
       SELECT $1, $2, current_date - 30, 'active', $3
        WHERE NOT EXISTS (SELECT 1 FROM batches WHERE program_id = $1 AND name = $2 AND deleted_at IS NULL)
       RETURNING id`,
      [prog.id, name, admin?.id ?? null],
    );
    if (rows[0]) { batches += 1; batchIds.push(rows[0].id); }
  }
  summary.batches_created = batches;

  // ---- 5. students across every lifecycle state ---------------------------
  // active / on_break / dropped so the Accounts drop-candidate and break
  // screens have rows too, not just the happy path.
  let students = 0;
  for (let i = 0; i < STUDENT_STATUSES.length; i += 1) {
    const status = STUDENT_STATUSES[i];
    const prog = programs[i % programs.length];
    const email = `student${i + 1}@demo.local`;
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO students (name, email, phone, program_id, status, password_hash, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [`Demo Student ${i + 1}`, email, `+91982000000${i + 1}`, prog?.id ?? null, status, hash, admin?.id ?? null],
    );
    if (rows[0]) students += 1;
  }
  summary.students_created = students;

  // ---- 6. leads spread across the real pipeline --------------------------
  // Stage codes are read FROM THE DB (they are tenant-editable and drift), and
  // ownership alternates between the counsellor and the telecaller so both
  // front-line portals open with a populated queue.
  const { rows: stages } = await tenantQuery(
    tenant,
    `SELECT id, code FROM lead_stages WHERE is_active AND deleted_at IS NULL ORDER BY order_index LIMIT 8`,
  );
  const owners = [byEmail['counsellor@demo.local']?.id, byEmail['telecaller@demo.local']?.id].filter(Boolean);
  let leads = 0;
  if (stages.length && owners.length) {
    for (let i = 0; i < 16; i += 1) {
      const stage = stages[i % stages.length];
      const owner = owners[i % owners.length];
      const name = `Demo Lead ${String(i + 1).padStart(2, '0')}`;
      const phone = `+91990000${String(1000 + i)}`;
      const { rows } = await tenantQuery(
        tenant,
        `INSERT INTO leads (name, phone, email, stage_id, assigned_to, branch_id, first_touch_source, last_activity_at)
         SELECT $1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' days')::interval
          WHERE NOT EXISTS (SELECT 1 FROM leads WHERE phone = $2 AND deleted_at IS NULL)
         RETURNING id`,
        [name, phone, `lead${i + 1}@demo.local`, stage.id, owner, branchId,
          ['Website', 'WhatsApp', 'Facebook', 'Direct Walkin'][i % 4], String(i)],
      );
      if (rows[0]) leads += 1;
    }
  }
  summary.leads_created = leads;

  // ---- 7. follow-ups: due today, overdue, and future ----------------------
  // Covers all three buckets the Follow-up Manager and the dashboard tiles
  // read, so none of them opens empty.
  const { rows: seededLeads } = await tenantQuery(
    tenant,
    `SELECT id, assigned_to FROM leads
      WHERE email LIKE 'lead%@demo.local' AND deleted_at IS NULL
      ORDER BY created_at LIMIT 9`,
  );
  let followups = 0;
  const OFFSETS = [-3, -1, 0, 0, 1, 2, 5, 7, 14]; // negative = overdue
  for (let i = 0; i < seededLeads.length; i += 1) {
    const l = seededLeads[i];
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO lead_followups (lead_id, next_action_datetime, status, comment, created_by)
       SELECT $1, now() + ($2 || ' days')::interval, 'planned', $3, $4
        WHERE NOT EXISTS (
          SELECT 1 FROM lead_followups WHERE lead_id = $1 AND deleted_at IS NULL
        )
       RETURNING id`,
      [l.id, String(OFFSETS[i % OFFSETS.length]), 'Demo follow-up — seeded', l.assigned_to],
    );
    if (rows[0]) followups += 1;
  }
  summary.followups_created = followups;

  // ---- 8. device recordings (matched, for the QA queue) -------------------
  // The QA review queue only surfaces MATCHED recordings, so these are bound to
  // a seeded lead and attributed to the front-line owner. r2_key points at a
  // placeholder path — playback will 404 against storage, which is correct for
  // demo data; the queue, scoping and review flow are what we want populated.
  let recordings = 0;
  for (let i = 0; i < Math.min(6, seededLeads.length); i += 1) {
    const l = seededLeads[i];
    const { rows: [lead] } = await tenantQuery(tenant, `SELECT phone FROM leads WHERE id = $1`, [l.id]);
    const digits = String(lead?.phone ?? '').replace(/\D/g, '').slice(-10);
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO device_recordings
         (lead_id, phone_raw, phone_digits, match_status, r2_key, file_name,
          size_bytes, duration_seconds, uploaded_by, branch_id, client_ref)
       SELECT $1,$2,$3,'matched',$4,$5,102400,95,$6,$7,$8
        WHERE NOT EXISTS (SELECT 1 FROM device_recordings WHERE client_ref = $8)
       RETURNING id`,
      [l.id, digits, digits, `demo/recordings/seed-${i + 1}.m4a`,
        `Call recording ${digits}_demo_${i + 1}.m4a`, l.assigned_to, branchId,
        `demo-seed-recording-${i + 1}`],
    );
    if (rows[0]) recordings += 1;
  }
  summary.recordings_created = recordings;

  logger.info({ slug, ...summary }, 'seed-demo-full: done');
  return { tenant, hash, roleId, branchId, admin, byEmail, summary };
};

main()
  .then(async (ctx) => {
    // eslint-disable-next-line no-console
    console.log('\n=== seed-demo-full summary ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(ctx.summary, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\nAll seeded users log in with: ${PASSWORD}\n`);
    await closeAllTenantPools();
    await closeSystemPool();
  })
  .catch(async (err) => {
    logger.error({ err: err.message }, 'seed-demo-full failed');
    // eslint-disable-next-line no-console
    console.error(err);
    await closeAllTenantPools().catch(() => {});
    await closeSystemPool().catch(() => {});
    process.exit(1);
  });
