import { tenantQuery, tenantTx } from '../../db/tenant.js';

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
