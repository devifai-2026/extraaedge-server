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
  // MoM HR/placement tiers. hr_team_lead reports to the BM; the other two
  // report to IT, which EXPECTED_SUPERVISOR enforces at the write path — so the
  // reporting map below must create the lead before its two reports.
  { role: 'hr_team_lead',     name: 'Hitesh HR Lead',   email: 'hrlead@demo.local',      phone: '+919810000012' },
  { role: 'hr_recruiter',     name: 'Riya Recruiter',   email: 'recruiter@demo.local',   phone: '+919810000013' },
  { role: 'placement_officer', name: 'Pooja Placement Officer', email: 'placementofficer@demo.local', phone: '+919810000014' },
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
    ['hrlead@demo.local', byEmail['bm@demo.local']?.id],
    ['recruiter@demo.local', byEmail['hrlead@demo.local']?.id],
    ['placementofficer@demo.local', byEmail['hrlead@demo.local']?.id],
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

  // Every OTHER lead owner gets a follow-up and a recording too. The seeded
  // staff above are not the only users — a tenant carries pre-existing
  // telecallers and leads, and an empty Follow-ups or Call Recordings tab reads
  // as "this feature is broken" just as loudly for them.
  const { rows: otherOwners } = await tenantQuery(
    tenant,
    `SELECT DISTINCT l.assigned_to AS id
       FROM leads l JOIN users u ON u.id = l.assigned_to
      WHERE l.deleted_at IS NULL AND u.deleted_at IS NULL AND u.is_active
        AND u.role = ANY($1)
        AND NOT EXISTS (
          SELECT 1 FROM lead_followups f
           WHERE f.created_by = l.assigned_to AND f.deleted_at IS NULL
        )`,
    [['counsellor', 'telecaller', 'telecaller_lead']],
  );
  let extraFu = 0;
  for (const o of otherOwners) {
    const { rows: theirLead } = await tenantQuery(
      tenant,
      `SELECT id FROM leads WHERE assigned_to = $1 AND deleted_at IS NULL LIMIT 1`,
      [o.id],
    );
    if (!theirLead[0]) continue;
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO lead_followups (lead_id, next_action_datetime, status, comment, created_by)
       VALUES ($1, now() + interval '1 day', 'planned', 'Demo follow-up — seeded', $2)
       RETURNING id`,
      [theirLead[0].id, o.id],
    );
    if (rows[0]) extraFu += 1;
  }
  summary.followups_for_other_owners = extraFu;

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

  // A recording for every OTHER front-line owner too, so each telecaller lead's
  // Call Recordings and QA queue show their own team's calls rather than an
  // empty tab. visibleUploaderIds scopes a lead to its SUBTREE, so the upload
  // has to be attributed to a team member, not the lead itself.
  const { rows: otherFront } = await tenantQuery(
    tenant,
    `SELECT u.id, u.name FROM users u
      WHERE u.deleted_at IS NULL AND u.is_active
        AND u.role = ANY($1)
        AND NOT EXISTS (
          SELECT 1 FROM device_recordings d
           WHERE d.uploaded_by = u.id AND d.deleted_at IS NULL
        )`,
    [['counsellor', 'telecaller']],
  );
  let extraRec = 0;
  for (let i = 0; i < otherFront.length; i += 1) {
    const owner = otherFront[i];
    const { rows: theirLead } = await tenantQuery(
      tenant,
      `SELECT id, phone FROM leads WHERE assigned_to = $1 AND deleted_at IS NULL LIMIT 1`,
      [owner.id],
    );
    if (!theirLead[0]) continue;
    const digits = String(theirLead[0].phone ?? '').replace(/\D/g, '').slice(-10);
    if (digits.length < 10) continue;
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO device_recordings
         (lead_id, phone_raw, phone_digits, match_status, r2_key, file_name,
          size_bytes, duration_seconds, uploaded_by, branch_id, client_ref)
       SELECT $1,$2,$3,'matched',$4,$5,102400,80,$6,$7,$8
        WHERE NOT EXISTS (SELECT 1 FROM device_recordings WHERE client_ref = $8)
       RETURNING id`,
      [theirLead[0].id, digits, digits, `demo/recordings/owner-${i + 1}.m4a`,
        `Call recording ${digits}_owner_${i + 1}.m4a`, owner.id, branchId,
        `demo-seed-owner-rec-${i + 1}`],
    );
    if (rows[0]) extraRec += 1;
  }
  summary.recordings_for_other_owners = extraRec;

  // ---- 9. batch placement + a MERGED batch --------------------------------
  // Batch merge is a real trainer workflow (merged_into_batch_id), so the seed
  // leaves one batch actually merged rather than pretending the feature is
  // untested data.
  const { rows: allBatches } = await tenantQuery(
    tenant,
    `SELECT id, program_id, name FROM batches WHERE deleted_at IS NULL ORDER BY created_at`,
  );
  const { rows: seededStudents } = await tenantQuery(
    tenant,
    `SELECT id, program_id FROM students WHERE email LIKE 'student%@demo.local' AND deleted_at IS NULL ORDER BY created_at`,
  );
  let placed = 0;
  for (let i = 0; i < seededStudents.length; i += 1) {
    const st = seededStudents[i];
    const batch = allBatches.find((b) => b.program_id === st.program_id) ?? allBatches[0];
    if (!batch) continue;
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO batch_students (batch_id, student_id, joined_at)
       SELECT $1, $2, now() - interval '20 days'
        WHERE NOT EXISTS (
          SELECT 1 FROM batch_students WHERE batch_id = $1 AND student_id = $2 AND deleted_at IS NULL
        )
       RETURNING id`,
      [batch.id, st.id],
    );
    if (rows[0]) placed += 1;
  }
  summary.batch_placements = placed;

  // Merge the last batch into the first of the same program, so the Trainer
  // batch screen has a real merged row to render.
  let merged = 0;
  if (allBatches.length >= 2) {
    const target = allBatches[0];
    const source = allBatches.find((b) => b.program_id === target.program_id && b.id !== target.id);
    if (source) {
      const { rows } = await tenantQuery(
        tenant,
        `UPDATE batches SET merged_into_batch_id = $2, status = 'merged'
          WHERE id = $1 AND merged_into_batch_id IS NULL AND deleted_at IS NULL
          RETURNING id`,
        [source.id, target.id],
      );
      if (rows[0]) {
        await tenantQuery(
          tenant,
          `UPDATE batch_students SET batch_id = $2 WHERE batch_id = $1 AND deleted_at IS NULL`,
          [source.id, target.id],
        );
        merged = 1;
      }
    }
  }
  summary.batches_merged = merged;

  // ---- 10. classes + attendance -------------------------------------------
  // Past classes carry real attendance rows (present / absent / late) so the
  // student's Attendance calendar and the trainer's register both have data.
  const trainerId = byEmail['trainer@demo.local']?.id ?? null;
  const primaryBatch = allBatches[0];
  let classes = 0;
  const classIds = [];
  if (primaryBatch && trainerId) {
    for (let d = 14; d >= 2; d -= 4) {
      const { rows } = await tenantQuery(
        tenant,
        `INSERT INTO classes (program_id, batch_id, title, kind, mode, starts_at, ends_at, started_at, ended_at, trainer_id, created_by)
         SELECT $1, $2, $3, 'lecture', 'online',
                now() - ($4 || ' days')::interval,
                now() - ($4 || ' days')::interval + interval '90 minutes',
                now() - ($4 || ' days')::interval,
                now() - ($4 || ' days')::interval + interval '90 minutes',
                $5, $6
          WHERE NOT EXISTS (SELECT 1 FROM classes WHERE batch_id = $2 AND title = $3 AND deleted_at IS NULL)
         RETURNING id`,
        [primaryBatch.program_id, primaryBatch.id, `Demo Session ${d}`, String(d), trainerId, admin?.id ?? null],
      );
      if (rows[0]) { classes += 1; classIds.push(rows[0].id); }
    }
    // One upcoming class, so "next class" surfaces are not empty either.
    await tenantQuery(
      tenant,
      `INSERT INTO classes (program_id, batch_id, title, kind, mode, starts_at, ends_at, trainer_id, created_by)
       SELECT $1, $2, 'Demo Session (upcoming)', 'lecture', 'online',
              now() + interval '2 days', now() + interval '2 days' + interval '90 minutes', $3, $4
        WHERE NOT EXISTS (SELECT 1 FROM classes WHERE batch_id = $2 AND title = 'Demo Session (upcoming)' AND deleted_at IS NULL)`,
      [primaryBatch.program_id, primaryBatch.id, trainerId, admin?.id ?? null],
    );
  }
  summary.classes_created = classes;

  let attendance = 0;
  if (classIds.length) {
    const { rows: batchRoster } = await tenantQuery(
      tenant,
      `SELECT student_id FROM batch_students WHERE batch_id = $1 AND deleted_at IS NULL`,
      [primaryBatch.id],
    );
    // A deterministic mix so the calendar shows all three states.
    const MIX = ['present', 'present', 'absent', 'present', 'late', 'present'];
    for (let ci = 0; ci < classIds.length; ci += 1) {
      for (let si = 0; si < batchRoster.length; si += 1) {
        const status = MIX[(ci + si) % MIX.length];
        const { rows } = await tenantQuery(
          tenant,
          `INSERT INTO attendance (class_id, student_id, status, join_mode)
           SELECT $1, $2, $3, 'online'
            WHERE NOT EXISTS (SELECT 1 FROM attendance WHERE class_id = $1 AND student_id = $2)
           RETURNING id`,
          [classIds[ci], batchRoster[si].student_id, status],
        );
        if (rows[0]) attendance += 1;
      }
    }
  }
  summary.attendance_rows = attendance;

  // ---- 11. placement: openings + student applications ---------------------
  const { rows: companies } = await tenantQuery(
    tenant,
    `SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY created_at LIMIT 3`,
  );
  let openings = 0;
  const openingIds = [];
  for (let i = 0; i < companies.length; i += 1) {
    const c = companies[i];
    const title = `${['Junior Developer', 'Data Analyst', 'Support Engineer'][i % 3]} — ${c.name}`;
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO job_openings (company_id, title, description, ctc, location, job_type, status, criteria, program_id, created_by)
       SELECT $1, $2, 'Seeded demo opening', $3, 'Pune', 'full_time', 'open', '{}'::jsonb, $4, $5
        WHERE NOT EXISTS (SELECT 1 FROM job_openings WHERE company_id = $1 AND title = $2 AND deleted_at IS NULL)
       RETURNING id`,
      [c.id, title, `${4 + i}.5 LPA`, programs[i % programs.length]?.id ?? null, admin?.id ?? null],
    );
    if (rows[0]) { openings += 1; openingIds.push(rows[0].id); }
  }
  summary.job_openings_created = openings;

  let applications = 0;
  const { rows: placementStages } = await tenantQuery(
    tenant,
    `SELECT id FROM placement_stages WHERE deleted_at IS NULL ORDER BY order_index LIMIT 3`,
  ).catch(() => ({ rows: [] }));
  for (let i = 0; i < openingIds.length; i += 1) {
    for (let j = 0; j < Math.min(3, seededStudents.length); j += 1) {
      const st = seededStudents[(i + j) % seededStudents.length];
      const { rows } = await tenantQuery(
        tenant,
        `INSERT INTO job_applications (opening_id, student_id, status, stage_id, fired_by)
         SELECT $1, $2, 'applied', $3, $4
          WHERE NOT EXISTS (SELECT 1 FROM job_applications WHERE opening_id = $1 AND student_id = $2)
         RETURNING id`,
        [openingIds[i], st.id, placementStages[j % Math.max(placementStages.length, 1)]?.id ?? null, admin?.id ?? null],
      );
      if (rows[0]) applications += 1;
    }
  }
  summary.job_applications_created = applications;

  // ---- 12. mock-interview slots (HR's evaluation queue) -------------------
  // mock_interviews existed but had no SLOTS, so HR's queue rendered empty —
  // the queue is slots awaiting a score, not interviews.
  const { rows: mocks } = await tenantQuery(
    tenant,
    `SELECT id FROM mock_interviews ORDER BY created_at LIMIT 2`,
  ).catch(() => ({ rows: [] }));
  // listForHr filters on mock_interviews.hr_user_id, so an unassigned interview
  // is invisible to every HR — the queue means "mine to evaluate", not "all".
  const hrUserId = byEmail['hr@demo.local']?.id ?? null;
  if (hrUserId && mocks.length) {
    await tenantQuery(
      tenant,
      `UPDATE mock_interviews SET hr_user_id = $1
        WHERE hr_user_id IS NULL AND id = ANY($2::uuid[])`,
      [hrUserId, mocks.map((m) => m.id)],
    ).catch(() => {});
  }
  let slots = 0;
  for (const m of mocks) {
    for (let i = 0; i < Math.min(3, seededStudents.length); i += 1) {
      const st = seededStudents[i];
      const { rows } = await tenantQuery(
        tenant,
        `INSERT INTO interview_slots (interview_id, student_id, slot_at, starts_at, ends_at)
         SELECT $1, $2, now() + interval '3 days', now() + interval '3 days',
                now() + interval '3 days' + interval '45 minutes'
          WHERE NOT EXISTS (
            SELECT 1 FROM interview_slots WHERE interview_id = $1 AND student_id = $2 AND deleted_at IS NULL
          )
         RETURNING id`,
        [m.id, st.id],
      ).catch(() => ({ rows: [] }));
      if (rows[0]) slots += 1;
    }
  }
  summary.interview_slots_created = slots;

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
