import { tenantQuery, tenantTx } from '../../db/tenant.js';

// ---------- Classes ----------
export const listClasses = async (tenant, { programId, batchId } = {}) => {
  const params = [];
  const conds = ['c.deleted_at IS NULL'];
  if (programId) { params.push(programId); conds.push(`c.program_id = $${params.length}`); }
  if (batchId) { params.push(batchId); conds.push(`c.batch_id = $${params.length}`); }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.*, b.name AS batch_name, m.name AS module_name,
            (SELECT u.name FROM users u WHERE u.id = c.trainer_id) AS trainer_name,
            (SELECT count(*)::int FROM class_recordings r WHERE r.class_id = c.id AND r.deleted_at IS NULL) AS recording_count
       FROM classes c
       JOIN batches b ON b.id = c.batch_id
       LEFT JOIN course_modules m ON m.id = c.module_id
      WHERE ${conds.join(' AND ')}
      ORDER BY c.starts_at DESC`,
    params,
  );
  return rows;
};

export const getClass = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.*, b.name AS batch_name, m.name AS module_name
       FROM classes c JOIN batches b ON b.id = c.batch_id
       LEFT JOIN course_modules m ON m.id = c.module_id
      WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
};

export const createClass = async (tenant, input, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO classes (program_id, module_id, batch_id, title, kind, mode, meeting_url, starts_at, ends_at, created_by, trainer_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [input.program_id, input.module_id ?? null, input.batch_id, input.title,
     input.kind ?? 'lecture', input.mode ?? 'online', input.meeting_url ?? null,
     input.starts_at, input.ends_at, actorId ?? null, input.trainer_id ?? null],
  );
  return rows[0];
};

export const updateClass = async (tenant, id, input) => {
  const sets = []; const params = [];
  const add = (c, v) => { params.push(v); sets.push(`${c} = $${params.length}`); };
  for (const k of ['title', 'kind', 'mode', 'meeting_url', 'starts_at', 'ends_at', 'module_id', 'trainer_id']) {
    if (input[k] !== undefined) add(k, input[k]);
  }
  if (!sets.length) return getClass(tenant, id);
  params.push(id);
  const { rows } = await tenantQuery(tenant, `UPDATE classes SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`, params);
  return rows[0] || null;
};

export const deleteClass = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE classes SET deleted_at = now() WHERE id = $1`, [id]);
};

// Trainer lifecycle: stamp started/ended + write the trainer_attendance row.
export const markLifecycle = async (tenant, classId, action, trainerId) =>
  tenantTx(tenant, async (client) => {
    if (action === 'class_started') await client.query(`UPDATE classes SET started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`, [classId]);
    if (action === 'class_ended') await client.query(`UPDATE classes SET ended_at = now(), updated_at = now() WHERE id = $1`, [classId]);
    await client.query(`INSERT INTO trainer_attendance (class_id, trainer_id, action) VALUES ($1,$2,$3)`, [classId, trainerId, action]);
    const { rows } = await client.query(`SELECT * FROM classes WHERE id = $1`, [classId]);
    return rows[0];
  });

// ---------- Question bank (per module) ----------
export const listBank = async (tenant, moduleId) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM attendance_bank_questions WHERE module_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [moduleId]);
  return rows;
};
export const addBankQuestion = async (tenant, moduleId, input, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO attendance_bank_questions (module_id, question, options, correct_index, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [moduleId, input.question, JSON.stringify(input.options ?? []), input.correct_index ?? null, actorId ?? null],
  );
  return rows[0];
};
export const deleteBankQuestion = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE attendance_bank_questions SET deleted_at = now() WHERE id = $1`, [id]);
};

// ---------- Fire question + answers ----------
export const fireQuestion = async (tenant, classId, input, actorId) => {
  const minutes = Math.max(1, Number(input.visible_minutes) || 5);
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO attendance_questions (class_id, question, options, correct_index, source, visible_minutes, closes_at, fired_by)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $6), $7) RETURNING *`,
    [classId, input.question, JSON.stringify(input.options ?? []), input.correct_index ?? null,
     input.source ?? 'adhoc', minutes, actorId ?? null],
  );
  return rows[0];
};

export const listQuestions = async (tenant, classId) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM attendance_questions WHERE class_id = $1 ORDER BY fired_at`, [classId]);
  return rows;
};

// Student answers a fired question — only if still within the window.
export const answerQuestion = async (tenant, questionId, studentId, optionIndex) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO attendance_answers (question_id, student_id, option_index)
     SELECT $1, $2, $3
      WHERE EXISTS (SELECT 1 FROM attendance_questions q WHERE q.id = $1 AND q.closes_at > now())
     ON CONFLICT (question_id, student_id) DO NOTHING
     RETURNING *`,
    [questionId, studentId, optionIndex],
  );
  return rows[0] || null; // null => window closed or already answered
};

// ---------- Attendance computation ----------
// "present" = the student answered EVERY question fired in this class. Computed
// from the answers; recomputed on demand. Students who never joined get no
// attendance row from here (they stay absent).
export const recomputeAttendance = async (tenant, classId) =>
  tenantTx(tenant, async (client) => {
    const { rows: qs } = await client.query(`SELECT id FROM attendance_questions WHERE class_id = $1`, [classId]);
    const totalQ = qs.length;
    // Students who answered at least one question in this class.
    const { rows: answered } = await client.query(
      `SELECT a.student_id, count(*)::int AS answered
         FROM attendance_answers a
         JOIN attendance_questions q ON q.id = a.question_id
        WHERE q.class_id = $1
        GROUP BY a.student_id`,
      [classId],
    );
    for (const r of answered) {
      // Never downgrade a trainer's manual edit; only auto-set when not edited.
      const present = totalQ > 0 && r.answered >= totalQ;
      await client.query(
        `INSERT INTO attendance (class_id, student_id, status)
         VALUES ($1,$2,$3)
         ON CONFLICT (class_id, student_id) DO UPDATE
           SET status = CASE WHEN attendance.edited_at IS NULL THEN EXCLUDED.status ELSE attendance.status END,
               updated_at = now()`,
        [classId, r.student_id, present ? 'present' : 'absent'],
      );
    }
    return { totalQuestions: totalQ, students: answered.length };
  });

// Full attendance table for a class (all batch students + their status).
export const attendanceTable = async (tenant, classId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id AS student_id, s.name, s.email,
            CASE
              WHEN att.status IS NOT NULL THEN att.status
              WHEN c.ended_at IS NOT NULL THEN 'absent'
              ELSE 'pending'
            END AS status,
            att.join_mode, att.pre_notified_absent, att.reason, att.edited_by, att.edited_at,
            eu.name AS edited_by_name,
            (SELECT count(*)::int FROM attendance_answers aa
               JOIN attendance_questions q ON q.id = aa.question_id
              WHERE q.class_id = $1 AND aa.student_id = s.id) AS answered
       FROM classes c
       JOIN batch_students bs ON bs.batch_id = c.batch_id AND bs.deleted_at IS NULL
       JOIN students s ON s.id = bs.student_id AND s.deleted_at IS NULL
       LEFT JOIN attendance att ON att.class_id = c.id AND att.student_id = s.id
       LEFT JOIN users eu ON eu.id = att.edited_by
      WHERE c.id = $1
      ORDER BY s.name`,
    [classId],
  );
  return rows;
};

// Trainer manual override — sets status + edited_by flag.
export const editAttendance = async (tenant, classId, studentId, status, editorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO attendance (class_id, student_id, status, edited_by, edited_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (class_id, student_id) DO UPDATE
       SET status = EXCLUDED.status, edited_by = EXCLUDED.edited_by, edited_at = now(), updated_at = now()
     RETURNING *`,
    [classId, studentId, status, editorId],
  );
  return rows[0];
};

// Student pre-notifies absence for a class → auto-absent (flagged).
export const preNotifyAbsence = async (tenant, classId, studentId, reason = null) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO attendance (class_id, student_id, status, pre_notified_absent, reason)
     VALUES ($1,$2,'absent',true,$3)
     ON CONFLICT (class_id, student_id) DO UPDATE
       SET pre_notified_absent = true, reason = COALESCE($3, attendance.reason), updated_at = now()
     RETURNING *`,
    [classId, studentId, reason],
  );
  return rows[0];
};

// Student marks how they joined (online/offline) for a class they attend.
export const setJoinMode = async (tenant, classId, studentId, joinMode, reason = null) => {
  await tenantQuery(
    tenant,
    `INSERT INTO attendance (class_id, student_id, join_mode, reason)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (class_id, student_id) DO UPDATE
       SET join_mode = EXCLUDED.join_mode, reason = COALESCE($4, attendance.reason), updated_at = now()`,
    [classId, studentId, joinMode, reason],
  );
};

// ---------- Student class list (their batch) ----------
export const studentClasses = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.title, c.kind, c.mode, c.meeting_url, c.starts_at, c.ends_at, c.started_at, c.ended_at,
            m.name AS module_name,
            CASE
              WHEN att.status = 'present' THEN 'present'
              WHEN att.edited_at IS NOT NULL THEN att.status          -- trainer's manual mark sticks
              WHEN att.pre_notified_absent THEN 'absent'              -- student said "can't attend"
              WHEN c.ended_at IS NOT NULL THEN COALESCE(att.status, 'absent') -- final once ended
              ELSE 'upcoming'                                         -- not ended yet → never auto-absent
            END AS my_status, att.pre_notified_absent
       FROM batch_students bs
       JOIN classes c ON c.batch_id = bs.batch_id AND c.deleted_at IS NULL
       LEFT JOIN course_modules m ON m.id = c.module_id
       LEFT JOIN attendance att ON att.class_id = c.id AND att.student_id = bs.student_id
      WHERE bs.student_id = $1 AND bs.deleted_at IS NULL
      ORDER BY c.starts_at DESC`,
    [studentId],
  );
  return rows;
};

// Currently-open questions for a class the student can answer right now.
export const openQuestionsForStudent = async (tenant, classId, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT q.id, q.question, q.options, q.closes_at,
            (SELECT 1 FROM attendance_answers a WHERE a.question_id = q.id AND a.student_id = $2) AS answered
       FROM attendance_questions q
      WHERE q.class_id = $1 AND q.closes_at > now()
      ORDER BY q.fired_at`,
    [classId, studentId],
  );
  return rows.map((r) => ({ ...r, answered: !!r.answered }));
};

// Is this student in the class's batch? (authorization for answering)
export const studentInClassBatch = async (tenant, classId, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT 1 FROM classes c
       JOIN batch_students bs ON bs.batch_id = c.batch_id AND bs.deleted_at IS NULL
      WHERE c.id = $1 AND bs.student_id = $2 AND c.deleted_at IS NULL LIMIT 1`,
    [classId, studentId],
  );
  return rows.length > 0;
};

export const classBatchId = async (tenant, classId) => {
  const { rows } = await tenantQuery(tenant, `SELECT batch_id, program_id FROM classes WHERE id = $1 AND deleted_at IS NULL`, [classId]);
  return rows[0] || null;
};
