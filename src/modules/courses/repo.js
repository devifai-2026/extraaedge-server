import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { leaderboard } from '../assessments/repo.js';

// ---------- Course membership (the trainer scope key) ----------

// Is this user on the course's trainer roster (any role)? Used to scope trainer
// reads/writes to their own courses.
export const isCourseTrainer = async (tenant, programId, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT role FROM course_trainers
      WHERE program_id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [programId, userId],
  );
  return rows[0] || null; // { role } | null
};

// Program ids this user teaches (head or trainer) — for "my courses" lists.
export const courseIdsForTrainer = async (tenant, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT DISTINCT program_id FROM course_trainers
      WHERE user_id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  return rows.map((r) => r.program_id);
};

// ---------- Courses (programs used as LMS courses) ----------

// Courses list. When trainerId is set, only the courses that user teaches.
export const listCourses = async (tenant, { trainerId } = {}) => {
  const params = [];
  let where = 'p.deleted_at IS NULL AND p.is_active = true';
  if (trainerId) {
    params.push(trainerId);
    where += ` AND EXISTS (SELECT 1 FROM course_trainers ct
                            WHERE ct.program_id = p.id AND ct.user_id = $${params.length} AND ct.deleted_at IS NULL)`;
  }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT p.id, p.name, p.code, p.type, p.duration_value, p.duration_unit,
            (SELECT count(*)::int FROM course_modules m WHERE m.program_id = p.id AND m.deleted_at IS NULL) AS module_count,
            (SELECT count(*)::int FROM batches b WHERE b.program_id = p.id AND b.deleted_at IS NULL AND b.status <> 'merged') AS batch_count,
            (SELECT u.name FROM course_trainers ct JOIN users u ON u.id = ct.user_id
              WHERE ct.program_id = p.id AND ct.role = 'head' AND ct.deleted_at IS NULL LIMIT 1) AS head_trainer_name
       FROM programs p
      WHERE ${where}
      ORDER BY p.name`,
    params,
  );
  return rows;
};

export const getCourse = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, code, description, type, price, currency, duration_value, duration_unit
       FROM programs WHERE id = $1 AND deleted_at IS NULL`,
    [programId],
  );
  return rows[0] || null;
};

// ---------- Modules ----------

export const listModules = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT m.id, m.name, m.description, m.order_index, m.syllabus,
            (SELECT u.name FROM course_trainers ct JOIN users u ON u.id = ct.user_id
              WHERE ct.module_id = m.id AND ct.deleted_at IS NULL LIMIT 1) AS trainer_name
       FROM course_modules m
      WHERE m.program_id = $1 AND m.deleted_at IS NULL
      ORDER BY m.order_index, m.created_at`,
    [programId],
  );
  return rows;
};

export const createModule = async (tenant, programId, input, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO course_modules (program_id, name, description, order_index, syllabus, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [programId, input.name, input.description ?? null, input.order_index ?? 0,
     JSON.stringify(input.syllabus ?? []), actorId ?? null],
  );
  return rows[0];
};

export const updateModule = async (tenant, moduleId, input) => {
  const sets = [];
  const params = [];
  const add = (col, val, jsonb = false) => { params.push(jsonb ? JSON.stringify(val) : val); sets.push(`${col} = $${params.length}`); };
  if (input.name !== undefined) add('name', input.name);
  if (input.description !== undefined) add('description', input.description);
  if (input.order_index !== undefined) add('order_index', input.order_index);
  if (input.syllabus !== undefined) add('syllabus', input.syllabus, true);
  if (!sets.length) return null;
  params.push(moduleId);
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE course_modules SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`,
    params,
  );
  return rows[0] || null;
};

export const deleteModule = async (tenant, moduleId) => {
  await tenantQuery(tenant, `UPDATE course_modules SET deleted_at = now() WHERE id = $1`, [moduleId]);
};

// ---------- Trainers (roster) ----------

export const listTrainers = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ct.id, ct.user_id, ct.role, ct.module_id, u.name AS user_name, u.email AS user_email,
            m.name AS module_name
       FROM course_trainers ct
       JOIN users u ON u.id = ct.user_id
       LEFT JOIN course_modules m ON m.id = ct.module_id
      WHERE ct.program_id = $1 AND ct.deleted_at IS NULL
      ORDER BY (ct.role = 'head') DESC, u.name`,
    [programId],
  );
  return rows;
};

export const addTrainer = async (tenant, programId, { user_id, role = 'trainer', module_id = null }, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO course_trainers (program_id, user_id, role, module_id, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [programId, user_id, role, module_id, actorId ?? null],
  );
  return rows[0];
};

export const removeTrainer = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE course_trainers SET deleted_at = now() WHERE id = $1`, [id]);
};

// Distinct user_ids on a course's trainer roster — for notifying the teaching
// team (e.g. when a new student is confirmed into the course).
export const courseTrainerUserIds = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT DISTINCT user_id FROM course_trainers WHERE program_id = $1 AND deleted_at IS NULL`,
    [programId],
  );
  return rows.map((r) => r.user_id).filter(Boolean);
};

// Per-student attendance summary across a course's ended classes (their batch's
// classes). Drives the trainer "attendance history" view.
export const attendanceHistory = async (tenant, programId, branchId = null) => {
  const params = [programId];
  let join = ''; let filter = '';
  if (branchId) { params.push(branchId); join = 'LEFT JOIN admissions a ON a.id = s.admission_id LEFT JOIN leads l ON l.id = a.lead_id'; filter = `AND l.branch_id = $${params.length}`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id AS student_id, s.name, b.name AS batch_name,
            count(c.id) FILTER (WHERE c.ended_at IS NOT NULL) AS total,
            count(*) FILTER (WHERE att.status = 'present' AND c.ended_at IS NOT NULL) AS present,
            count(*) FILTER (WHERE att.status = 'absent' AND c.ended_at IS NOT NULL) AS absent
       FROM students s
       JOIN batch_students bs ON bs.student_id = s.id AND bs.deleted_at IS NULL
       JOIN batches b ON b.id = bs.batch_id AND b.deleted_at IS NULL
       LEFT JOIN classes c ON c.batch_id = bs.batch_id AND c.deleted_at IS NULL AND c.program_id = $1
       LEFT JOIN attendance att ON att.class_id = c.id AND att.student_id = s.id
       ${join}
      WHERE s.program_id = $1 AND s.deleted_at IS NULL ${filter}
      GROUP BY s.id, s.name, b.name
      ORDER BY s.name`,
    params,
  );
  return rows.map((r) => {
    const total = Number(r.total) || 0;
    const present = Number(r.present) || 0;
    return { student_id: r.student_id, name: r.name, batch_name: r.batch_name, present, absent: Number(r.absent) || 0, total, pct: total ? Math.round((present / total) * 100) : null };
  });
};

export const firstBranchId = async (tenant) => {
  const { rows } = await tenantQuery(tenant, `SELECT id FROM branches WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`, []);
  return rows[0]?.id || null;
};

// All active branches (for admins' switcher).
export const allBranches = async (tenant) => {
  const { rows } = await tenantQuery(tenant, `SELECT id, name, code FROM branches WHERE deleted_at IS NULL ORDER BY name`, []);
  return rows;
};

// The branches a teaching user can switch between: their primary users.branch_id
// plus any user_branches rows.
export const branchesForUser = async (tenant, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT b.id, b.name, b.code FROM branches b
      WHERE b.deleted_at IS NULL AND (
        b.id = (SELECT branch_id FROM users WHERE id = $1)
        OR b.id IN (SELECT branch_id FROM user_branches WHERE user_id = $1)
      )
      ORDER BY b.name`,
    [userId],
  );
  return rows;
};

export const setBatchCompleted = async (tenant, batchId) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE batches SET status = 'completed', end_date = COALESCE(end_date, CURRENT_DATE), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [batchId],
  );
  return rows[0];
};

// ---------- Dashboard insights (across a trainer's courses) ----------
export const countStudentsForPrograms = async (tenant, programIds, branchId = null) => {
  const params = [programIds];
  let join = ''; let filter = '';
  if (branchId) { params.push(branchId); join = 'LEFT JOIN admissions a ON a.id = s.admission_id LEFT JOIN leads l ON l.id = a.lead_id'; filter = `AND l.branch_id = $${params.length}`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE s.status = 'active')::int AS active,
            count(*) FILTER (WHERE s.status = 'on_break')::int AS on_break,
            count(*) FILTER (WHERE s.status = 'dropped')::int AS dropped,
            count(*) FILTER (WHERE s.status NOT IN ('active','on_break','dropped'))::int AS pending,
            count(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM batch_students bs WHERE bs.student_id = s.id AND bs.deleted_at IS NULL
            ) AND s.status <> 'dropped')::int AS unassigned
       FROM students s ${join}
      WHERE s.program_id = ANY($1::uuid[]) AND s.deleted_at IS NULL ${filter}`,
    params,
  );
  return rows[0] || { total: 0, active: 0, on_break: 0, dropped: 0, pending: 0, unassigned: 0 };
};

// Per-course rollup for the dashboard (students + batches + modules + classes).
export const perCourseStats = async (tenant, programIds) => {
  if (!programIds.length) return [];
  const { rows } = await tenantQuery(
    tenant,
    `SELECT p.id AS program_id, p.name,
            (SELECT count(*)::int FROM students s WHERE s.program_id = p.id AND s.deleted_at IS NULL) AS students,
            (SELECT count(*)::int FROM batches b WHERE b.program_id = p.id AND b.deleted_at IS NULL AND b.status <> 'merged') AS batches,
            (SELECT count(*)::int FROM course_modules m WHERE m.program_id = p.id AND m.deleted_at IS NULL) AS modules,
            (SELECT count(*)::int FROM classes c WHERE c.program_id = p.id AND c.deleted_at IS NULL) AS classes
       FROM programs p WHERE p.id = ANY($1::uuid[]) AND p.deleted_at IS NULL
      ORDER BY p.name`,
    [programIds],
  );
  return rows;
};

// Recent students (for the avatar roster) with their batch + photo key.
export const studentsForPrograms = async (tenant, programIds, limit = 24, branchId = null) => {
  const params = [programIds];
  let join = ''; let filter = '';
  if (branchId) { params.push(branchId); join = 'LEFT JOIN admissions a ON a.id = s.admission_id LEFT JOIN leads l ON l.id = a.lead_id'; filter = `AND l.branch_id = $${params.length}`; }
  params.push(limit);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.name, s.email, s.status, s.photo_r2_key, p.name AS program_name,
            (SELECT b.name FROM batch_students bs JOIN batches b ON b.id = bs.batch_id
              WHERE bs.student_id = s.id AND bs.deleted_at IS NULL ORDER BY bs.joined_at DESC LIMIT 1) AS batch_name
       FROM students s
       LEFT JOIN programs p ON p.id = s.program_id
       ${join}
      WHERE s.program_id = ANY($1::uuid[]) AND s.deleted_at IS NULL ${filter}
      ORDER BY s.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
};

// Full student list (with batch + contact) across a set of programs — for the
// admin/head "Students" management table.
export const courseStudents = async (tenant, programIds, branchId = null) => {
  if (!programIds.length) return [];
  const hasBranches = await tenantQuery(tenant, `SELECT to_regclass('branches') IS NOT NULL AS ok`, []);
  const hasB = hasBranches.rows[0]?.ok;
  const branchJoin = hasB
    ? `LEFT JOIN admissions a ON a.id = s.admission_id
       LEFT JOIN leads l ON l.id = a.lead_id
       LEFT JOIN branches br ON br.id = l.branch_id`
    : '';
  const branchSel = hasB ? 'br.id AS branch_id, br.name AS branch_name,' : 'NULL::uuid AS branch_id, NULL::text AS branch_name,';
  const params = [programIds];
  let branchFilter = '';
  if (hasB && branchId) { params.push(branchId); branchFilter = `AND l.branch_id = $${params.length}`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.name, s.email, s.phone, s.status, s.program_id, p.name AS program_name,
            ${branchSel}
            (SELECT b.name FROM batch_students bs JOIN batches b ON b.id = bs.batch_id
              WHERE bs.student_id = s.id AND bs.deleted_at IS NULL ORDER BY bs.joined_at DESC LIMIT 1) AS batch_name
       FROM students s
       LEFT JOIN programs p ON p.id = s.program_id
       ${branchJoin}
      WHERE s.program_id = ANY($1::uuid[]) AND s.deleted_at IS NULL ${branchFilter}
      ORDER BY s.created_at DESC`,
    params,
  );
  return rows;
};

// Teaching staff who can be added to a course roster (head_trainer / trainer),
// so a head trainer (who can't list all users) can populate the picker.
export const assignableStaff = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, email, role FROM users
      WHERE role IN ('head_trainer','trainer') AND is_active = true AND deleted_at IS NULL
      ORDER BY name`,
    [],
  );
  return rows;
};

// ---------- Batches ----------

export const listBatches = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT b.id, b.name, b.start_date, b.end_date, b.status, b.merged_into_batch_id,
            (SELECT count(*)::int FROM batch_students bs WHERE bs.batch_id = b.id AND bs.deleted_at IS NULL) AS student_count
       FROM batches b
      WHERE b.program_id = $1 AND b.deleted_at IS NULL
      ORDER BY b.status = 'merged', b.created_at DESC`,
    [programId],
  );
  return rows;
};

export const createBatch = async (tenant, programId, input, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO batches (program_id, name, start_date, end_date, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [programId, input.name, input.start_date ?? null, input.end_date ?? null, actorId ?? null],
  );
  return rows[0];
};

export const getBatch = async (tenant, batchId) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM batches WHERE id = $1 AND deleted_at IS NULL`, [batchId]);
  return rows[0] || null;
};

// Students in a batch (+ enrolled but unbatched pool via program).
export const listBatchStudents = async (tenant, batchId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT bs.id AS membership_id, bs.joined_at, bs.recordings_from,
            s.id AS student_id, s.name, s.email, s.status
       FROM batch_students bs
       JOIN students s ON s.id = bs.student_id
      WHERE bs.batch_id = $1 AND bs.deleted_at IS NULL AND s.deleted_at IS NULL
      ORDER BY s.name`,
    [batchId],
  );
  return rows;
};

// The course's "Unassigned pool": confirmed students of this program not in any
// active batch yet.
export const listUnassignedStudents = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id AS student_id, s.name, s.email, s.status
       FROM students s
      WHERE s.program_id = $1 AND s.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM batch_students bs
           WHERE bs.student_id = s.id AND bs.deleted_at IS NULL)
      ORDER BY s.name`,
    [programId],
  );
  return rows;
};

// Place / move a student into a batch. shareRecordings=true sets recordings_from
// to the batch start (share the back-catalog); else the student only sees
// classes from join time onward. Removes any prior active membership (a move).
export const placeStudentInBatch = async (tenant, { batchId, studentId, shareRecordings }, actorId) =>
  tenantTx(tenant, async (client) => {
    const { rows: b } = await client.query(`SELECT start_date FROM batches WHERE id = $1`, [batchId]);
    const recordingsFrom = shareRecordings ? (b[0]?.start_date ?? null) : null;
    // Soft-remove any existing active membership (single-batch model = a move).
    await client.query(
      `UPDATE batch_students SET deleted_at = now() WHERE student_id = $1 AND deleted_at IS NULL`,
      [studentId],
    );
    const { rows } = await client.query(
      `INSERT INTO batch_students (batch_id, student_id, recordings_from, moved_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [batchId, studentId, recordingsFrom, actorId ?? null],
    );
    return rows[0];
  });

// Merge source batch into target: re-point active memberships, mark source
// merged. shareRecordings controls whether moved students get the target's
// back-catalog.
export const mergeBatches = async (tenant, { sourceBatchId, targetBatchId, shareRecordings }, actorId) =>
  tenantTx(tenant, async (client) => {
    const { rows: t } = await client.query(`SELECT start_date FROM batches WHERE id = $1 AND deleted_at IS NULL`, [targetBatchId]);
    if (!t[0]) throw new Error('Target batch not found');
    const recordingsFrom = shareRecordings ? (t[0].start_date ?? null) : null;
    // Move each active source member into the target (skip if already there).
    const { rows: members } = await client.query(
      `SELECT student_id FROM batch_students WHERE batch_id = $1 AND deleted_at IS NULL`,
      [sourceBatchId],
    );
    let moved = 0;
    for (const m of members) {
      const { rows: existing } = await client.query(
        `SELECT 1 FROM batch_students WHERE batch_id = $1 AND student_id = $2 AND deleted_at IS NULL`,
        [targetBatchId, m.student_id],
      );
      await client.query(`UPDATE batch_students SET deleted_at = now() WHERE batch_id = $1 AND student_id = $2 AND deleted_at IS NULL`, [sourceBatchId, m.student_id]);
      if (!existing[0]) {
        await client.query(
          `INSERT INTO batch_students (batch_id, student_id, recordings_from, moved_by) VALUES ($1,$2,$3,$4)`,
          [targetBatchId, m.student_id, recordingsFrom, actorId ?? null],
        );
        moved += 1;
      }
    }
    await client.query(
      `UPDATE batches SET status = 'merged', merged_into_batch_id = $2, updated_at = now() WHERE id = $1`,
      [sourceBatchId, targetBatchId],
    );
    return { moved, source: sourceBatchId, target: targetBatchId };
  });

// ---------- Student self-view: their course + modules + batch ----------

export const studentCourseView = async (tenant, studentId) => {
  const { rows: s } = await tenantQuery(
    tenant,
    `SELECT s.id, s.name, s.program_id, p.name AS program_name, p.description AS program_description,
            p.type AS program_type, p.duration_value, p.duration_unit
       FROM students s LEFT JOIN programs p ON p.id = s.program_id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [studentId],
  );
  if (!s[0]) return null;
  const student = s[0];
  const [{ rows: modules }, { rows: batch }] = await Promise.all([
    student.program_id
      ? tenantQuery(tenant, `SELECT id, name, description, order_index, syllabus FROM course_modules WHERE program_id = $1 AND deleted_at IS NULL ORDER BY order_index, created_at`, [student.program_id])
      : Promise.resolve({ rows: [] }),
    tenantQuery(tenant, `SELECT b.id, b.name, b.start_date, b.end_date FROM batch_students bs JOIN batches b ON b.id = bs.batch_id WHERE bs.student_id = $1 AND bs.deleted_at IS NULL AND b.deleted_at IS NULL LIMIT 1`, [studentId]),
  ]);
  return { course: student, modules, batch: batch[0] || null };
};

// Aggregated student dashboard: next class, stats, pending actions, recent
// announcements, leaderboard rank. All scoped to the student's own enrolment.
export const studentDashboard = async (tenant, studentId) => {
  const { rows: srows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.name, s.program_id, p.name AS program_name,
            (SELECT bs.batch_id FROM batch_students bs WHERE bs.student_id = s.id AND bs.deleted_at IS NULL LIMIT 1) AS batch_id
       FROM students s LEFT JOIN programs p ON p.id = s.program_id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [studentId],
  );
  const s = srows[0];
  if (!s) return null;
  const batchId = s.batch_id;

  const [nextClass, attend, tests, projects, announcements, lb] = await Promise.all([
    // Next upcoming class in the student's batch.
    batchId ? tenantQuery(tenant,
      `SELECT c.id, c.title, c.mode, c.meeting_url, c.starts_at, m.name AS module_name
         FROM classes c LEFT JOIN course_modules m ON m.id = c.module_id
        WHERE c.batch_id = $1 AND c.deleted_at IS NULL AND c.ended_at IS NULL AND c.starts_at >= now()
        ORDER BY c.starts_at LIMIT 1`, [batchId]) : Promise.resolve({ rows: [] }),
    // Attendance %: present / total classes that have a class in their batch.
    batchId ? tenantQuery(tenant,
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE att.status = 'present')::int AS present
         FROM classes c
         LEFT JOIN attendance att ON att.class_id = c.id AND att.student_id = $2
        WHERE c.batch_id = $1 AND c.deleted_at IS NULL AND c.ended_at IS NOT NULL`, [batchId, studentId]) : Promise.resolve({ rows: [{ total: 0, present: 0 }] }),
    // Tests: total published for their program + how many they've attempted + avg.
    tenantQuery(tenant,
      `SELECT (SELECT count(*)::int FROM mock_tests t WHERE t.program_id = $1 AND t.deleted_at IS NULL AND t.is_published) AS total,
              (SELECT count(*)::int FROM mock_test_attempts a JOIN mock_tests t ON t.id = a.test_id WHERE t.program_id = $1 AND a.student_id = $2) AS attempted`,
      [s.program_id, studentId]),
    // Projects: total + submitted + pending (not submitted, deadline not passed).
    tenantQuery(tenant,
      `SELECT (SELECT count(*)::int FROM projects pr WHERE pr.program_id = $1 AND pr.deleted_at IS NULL) AS total,
              (SELECT count(*)::int FROM project_submissions ps JOIN projects pr ON pr.id = ps.project_id WHERE pr.program_id = $1 AND ps.student_id = $2) AS submitted`,
      [s.program_id, studentId]),
    // Recent announcements (course + their batch), most recent 5.
    tenantQuery(tenant,
      `SELECT a.id, a.title, a.body, a.auto_source, a.created_at, u.name AS author_name
         FROM announcements a LEFT JOIN users u ON u.id = a.author_user_id
        WHERE a.program_id = $1 AND a.deleted_at IS NULL AND (a.batch_id IS NULL OR a.batch_id = $2)
        ORDER BY a.created_at DESC LIMIT 5`, [s.program_id, batchId]),
    // Leaderboard rank (reuse the derived leaderboard, then find this student).
    leaderboard(tenant, s.program_id),
  ]);

  const at = attend.rows[0] || { total: 0, present: 0 };
  const attendance_pct = at.total > 0 ? Math.round((at.present / at.total) * 1000) / 10 : null;
  const lbRows = lb || [];
  const myIdx = lbRows.findIndex((r) => r.student_id === studentId);

  return {
    student: { id: s.id, name: s.name, program_id: s.program_id, program_name: s.program_name },
    next_class: nextClass.rows[0] || null,
    stats: {
      attendance_pct,
      classes_total: at.total,
      classes_present: at.present,
      tests_total: tests.rows[0]?.total || 0,
      tests_attempted: tests.rows[0]?.attempted || 0,
      projects_total: projects.rows[0]?.total || 0,
      projects_submitted: projects.rows[0]?.submitted || 0,
    },
    pending: {
      tests_pending: Math.max(0, (tests.rows[0]?.total || 0) - (tests.rows[0]?.attempted || 0)),
      projects_pending: Math.max(0, (projects.rows[0]?.total || 0) - (projects.rows[0]?.submitted || 0)),
    },
    announcements: announcements.rows,
    leaderboard: {
      rank: myIdx >= 0 ? myIdx + 1 : null,
      total_students: lbRows.length,
      top: lbRows.slice(0, 5),
    },
  };
};

// ---------- Trainer leave (Phase G9c) ----------
export const createLeave = async (tenant, { trainer_id, from_date, to_date, reason }, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO trainer_leave (trainer_id, from_date, to_date, reason, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [trainer_id, from_date, to_date, reason ?? null, actorId ?? null],
  );
  return rows[0];
};

export const myLeaves = async (tenant, trainerId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, from_date, to_date, reason, status, created_at
       FROM trainer_leave WHERE trainer_id = $1 AND deleted_at IS NULL
      ORDER BY from_date DESC`,
    [trainerId],
  );
  return rows;
};

export const cancelLeave = async (tenant, id, trainerId) => {
  await tenantQuery(tenant, `UPDATE trainer_leave SET deleted_at = now() WHERE id = $1 AND trainer_id = $2`, [id, trainerId]);
};

// Upcoming leaves for the trainers on a course's roster (head-trainer view).
export const leavesForProgram = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT l.id, l.trainer_id, u.name AS trainer_name, l.from_date, l.to_date, l.reason, l.status
       FROM trainer_leave l
       JOIN users u ON u.id = l.trainer_id
      WHERE l.deleted_at IS NULL AND l.to_date >= current_date
        AND l.trainer_id IN (SELECT user_id FROM course_trainers WHERE program_id = $1 AND deleted_at IS NULL)
      ORDER BY l.from_date`,
    [programId],
  );
  return rows;
};
