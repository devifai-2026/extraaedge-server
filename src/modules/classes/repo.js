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
    // Ending a class IS marking it complete — that is the signal payroll counts.
    // Clearing auto_marked_at matters: a trainer completing a class the system
    // already auto-marked must not leave it looking system-decided.
    if (action === 'class_ended') {
      await client.query(
        `UPDATE classes
            SET ended_at = now(), completion_status = 'completed',
                auto_marked_at = NULL, updated_at = now()
          WHERE id = $1`,
        [classId],
      );
    }
    await client.query(`INSERT INTO trainer_attendance (class_id, trainer_id, action) VALUES ($1,$2,$3)`, [classId, trainerId, action]);
    const { rows } = await client.query(`SELECT * FROM classes WHERE id = $1`, [classId]);
    return rows[0];
  });

export const findClass = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant, `SELECT * FROM classes WHERE id = $1 AND deleted_at IS NULL`, [id],
  );
  return rows[0] ?? null;
};

// Explicit completion, with a status the trainer chooses. Separate from the
// lifecycle call because 'I did not conduct this' is a real answer, and the
// trainer should be able to say so rather than staying silent and letting the
// 24-hour sweep decide for them.
export const setCompletion = async (tenant, classId, { status, note, billable, actorId, isOverride }) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE classes
        SET completion_status = $2,
            completion_note   = COALESCE($3, completion_note),
            is_billable       = COALESCE($4, is_billable),
            ended_at          = CASE WHEN $2 = 'completed' THEN COALESCE(ended_at, now()) ELSE NULL END,
            auto_marked_at    = NULL,
            override_by       = CASE WHEN $6 THEN $5 ELSE override_by END,
            override_at       = CASE WHEN $6 THEN now() ELSE override_at END,
            updated_at        = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
    [classId, status, note ?? null, billable ?? null, actorId ?? null, !!isOverride],
  );
  return rows[0] ?? null;
};

// Classes the trainer STARTED and never ended, past their scheduled finish.
//
// This is the nag list. Ending a class is what closes attendance, stops further
// questions and feeds module completion, so a forgotten "End class" silently
// holds all three open — and the trainer has no reason to notice, because from
// their side the console just looks idle.
//
// Only started-but-not-ended classes qualify: one never started is a no-show,
// which the completion flow already handles, and nagging about it would bury
// the real cases.
export const unendedClassesFor = async (tenant, { trainerId = null, limit = 20 } = {}) => {
  const params = [limit];
  let cond = '';
  if (trainerId) { params.push(trainerId); cond = `AND c.trainer_id = $${params.length}`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.title, c.starts_at, c.ends_at, c.started_at, c.batch_id,
            b.name AS batch_name, m.name AS module_name,
            EXTRACT(EPOCH FROM (now() - c.ends_at))::bigint AS overdue_seconds
       FROM classes c
       LEFT JOIN batches b ON b.id = c.batch_id
       LEFT JOIN course_modules m ON m.id = c.module_id
      WHERE c.deleted_at IS NULL
        AND c.started_at IS NOT NULL
        AND c.ended_at IS NULL
        AND c.ends_at < now()
        ${cond}
      ORDER BY c.ends_at
      LIMIT $1`,
    params,
  );
  return rows;
};

// A trainer's outstanding confirmations, newest deadline first. `trainerId`
// null means the manager view: everyone's.
export const pendingCompletionsFor = async (tenant, { trainerId = null, limit = 200 } = {}) => {
  const params = [limit];
  let cond = '';
  if (trainerId) { params.push(trainerId); cond = `AND c.trainer_id = $${params.length}`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.title, c.kind, c.starts_at, c.ends_at, c.completion_status,
            c.completion_due_at, c.is_billable, c.auto_marked_at, c.completion_note,
            c.trainer_id, u.name AS trainer_name,
            b.name AS batch_name,
            (c.completion_due_at < now()) AS overdue
       FROM classes c
       LEFT JOIN users u ON u.id = c.trainer_id
       LEFT JOIN batches b ON b.id = c.batch_id
      WHERE c.deleted_at IS NULL
        AND c.ends_at <= now()
        AND (c.completion_status = 'pending' OR c.auto_marked_at IS NOT NULL)
        ${cond}
      ORDER BY c.completion_due_at NULLS LAST
      LIMIT $1`,
    params,
  );
  return rows;
};

// Classes past their deadline that nobody has marked. The worker's input.
export const overdueCompletions = async (tenant, { graceHours = 24, limit = 500 } = {}) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.title, c.trainer_id, c.ends_at, c.completion_due_at,
            c.completion_reminded_at, u.name AS trainer_name, u.email AS trainer_email
       FROM classes c
       LEFT JOIN users u ON u.id = c.trainer_id
      WHERE c.deleted_at IS NULL
        AND c.completion_status = 'pending'
        AND COALESCE(c.completion_due_at, c.ends_at + make_interval(hours => $1)) <= now()
      ORDER BY c.completion_due_at
      LIMIT $2`,
    [graceHours, limit],
  );
  return rows;
};

// Pending classes whose window is still open — what the reminder targets.
export const remindableClasses = async (tenant, { withinHours = 6 } = {}) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.title, c.trainer_id, c.ends_at, c.completion_due_at,
            u.name AS trainer_name, u.email AS trainer_email
       FROM classes c
       LEFT JOIN users u ON u.id = c.trainer_id
      WHERE c.deleted_at IS NULL
        AND c.completion_status = 'pending'
        AND c.completion_reminded_at IS NULL
        AND c.ends_at <= now()
        AND c.completion_due_at > now()
        AND c.completion_due_at <= now() + make_interval(hours => $1)
      ORDER BY c.completion_due_at`,
    [withinHours],
  );
  return rows;
};

export const markReminded = (tenant, ids) =>
  tenantQuery(tenant, `UPDATE classes SET completion_reminded_at = now() WHERE id = ANY($1::uuid[])`, [ids]);

// The sweep itself. Marks not_conducted and, critically, never touches a class
// a branch manager has already overridden.
export const autoMarkNotConducted = async (tenant, ids) => {
  if (!ids?.length) return [];
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE classes
        SET completion_status = 'not_conducted',
            auto_marked_at = now(),
            completion_note = COALESCE(completion_note,
              'Auto-marked: not confirmed within the allowed window'),
            updated_at = now()
      WHERE id = ANY($1::uuid[])
        AND completion_status = 'pending'
        AND override_by IS NULL
      RETURNING id, trainer_id, title`,
    [ids],
  );
  return rows;
};

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
export const questionById = async (tenant, questionId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, class_id, question, question_type, options, correct_index, closes_at
       FROM attendance_questions WHERE id = $1`,
    [questionId],
  );
  return rows[0] || null;
};

// A long_text answer carries no option, but option_index is NOT NULL — park a
// sentinel there and keep the real answer in answer_text.
export const LONG_TEXT_NO_OPTION = -1;

export const answerQuestion = async (tenant, questionId, studentId, optionIndex, answerText = null) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO attendance_answers (question_id, student_id, option_index, answer_text)
     SELECT $1, $2, $3, $4
      WHERE EXISTS (SELECT 1 FROM attendance_questions q WHERE q.id = $1 AND q.closes_at > now())
     ON CONFLICT (question_id, student_id) DO NOTHING
     RETURNING *`,
    [questionId, studentId, optionIndex, answerText],
  );
  return rows[0] || null; // null => window closed or already answered
};

// Trainer's manual verdict on a long_text answer. Only long_text is gradable
// this way — the choice kinds are settled by correct_index and must not be
// overridable, or the analytics would disagree with itself.
export const gradeAnswer = async (tenant, answerId, isCorrect, graderId) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE attendance_answers a
        SET is_correct_override = $2, graded_by = $3, graded_at = now()
       FROM attendance_questions q
      WHERE a.id = $1 AND q.id = a.question_id AND q.question_type = 'long_text'
      RETURNING a.*`,
    [answerId, isCorrect, graderId],
  );
  return rows[0] || null;
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

// ---------- Question analytics (trainer) ----------
// Every question fired in a class, each with the full roster of who answered
// what and whether it was right — by student name, which is what the trainer
// actually needs to act on.
//
// `verdict` is deliberately three-valued:
//   correct | wrong | ungraded
// 'ungraded' is a long_text answer the trainer hasn't reviewed yet, and a
// choice answer on a question fired with no correct_index set (the pre-existing
// rows, and any question the trainer chooses not to grade). Collapsing either
// into 'wrong' would overstate how badly the class did.
export const questionAnalytics = async (tenant, classId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT q.id, q.question, q.question_type, q.options, q.correct_index,
            q.fired_at, q.closes_at, q.visible_minutes, q.source,
            COALESCE(
              (SELECT json_agg(x ORDER BY x.name)
                 FROM (
                   SELECT s.id AS student_id, s.name, a.id AS answer_id,
                          a.option_index, a.answer_text, a.answered_at,
                          a.is_correct_override,
                          CASE
                            WHEN q.question_type = 'long_text' THEN
                              CASE WHEN a.is_correct_override IS NULL THEN 'ungraded'
                                   WHEN a.is_correct_override THEN 'correct'
                                   ELSE 'wrong' END
                            WHEN q.correct_index IS NULL THEN 'ungraded'
                            WHEN a.option_index = q.correct_index THEN 'correct'
                            ELSE 'wrong'
                          END AS verdict
                     FROM attendance_answers a
                     JOIN students s ON s.id = a.student_id AND s.deleted_at IS NULL
                    WHERE a.question_id = q.id
                 ) x),
              '[]'::json) AS answers,
            -- Students on the roster who never answered this one.
            COALESCE(
              (SELECT json_agg(json_build_object('student_id', s2.id, 'name', s2.name) ORDER BY s2.name)
                 FROM classes c2
                 JOIN batch_students bs2 ON bs2.batch_id = c2.batch_id AND bs2.deleted_at IS NULL
                 JOIN students s2 ON s2.id = bs2.student_id AND s2.deleted_at IS NULL
                WHERE c2.id = q.class_id
                  AND NOT EXISTS (SELECT 1 FROM attendance_answers a2
                                   WHERE a2.question_id = q.id AND a2.student_id = s2.id)),
              '[]'::json) AS no_answer
       FROM attendance_questions q
      WHERE q.class_id = $1
      ORDER BY q.fired_at`,
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
    `SELECT c.id, c.batch_id, c.title, c.kind, c.mode, c.meeting_url, c.starts_at, c.ends_at, c.started_at, c.ended_at,
            m.name AS module_name,
            CASE
              WHEN att.status = 'present' THEN 'present'
              WHEN att.edited_at IS NOT NULL THEN att.status          -- trainer's manual mark sticks
              WHEN att.pre_notified_absent THEN 'absent'              -- student said "can't attend"
              WHEN c.ended_at IS NOT NULL THEN COALESCE(att.status, 'absent') -- final once ended
              ELSE 'upcoming'                                         -- not ended yet → never auto-absent
            END AS my_status, att.pre_notified_absent,
            att.joined_at, att.join_count,
            -- The portal's join button is driven entirely by these two, so the
            -- rule lives in ONE place instead of being re-derived in the UI:
            --   not started -> ended -> joined -> joinable
            (c.started_at IS NOT NULL AND c.ended_at IS NULL) AS can_join,
            -- Feedback is only asked of students who were actually present.
            (c.ended_at IS NOT NULL
             AND att.status = 'present'
             AND NOT EXISTS (
               SELECT 1 FROM lms_feedback f
                WHERE f.scope = 'class' AND f.class_id = c.id
                  AND f.student_id = bs.student_id AND f.submitted_at IS NOT NULL
             )) AS feedback_due
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

// started_at/ended_at come along because every caller that guards on the class
// lifecycle (fire a question, answer one, join) resolves the class through this.
export const classBatchId = async (tenant, classId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT batch_id, program_id, started_at, ended_at, meeting_url, mode
       FROM classes WHERE id = $1 AND deleted_at IS NULL`,
    [classId],
  );
  return rows[0] || null;
};

// Student clicked through to the class. Recorded separately from join_mode
// (which is the student DECLARING how they will attend) — this is proof they
// actually opened it, and drives the Join/Rejoin button state.
export const recordJoin = async (tenant, classId, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO attendance (class_id, student_id, joined_at, join_count)
     VALUES ($1,$2, now(), 1)
     ON CONFLICT (class_id, student_id) DO UPDATE
       SET joined_at = COALESCE(attendance.joined_at, now()),
           join_count = attendance.join_count + 1,
           updated_at = now()
     RETURNING joined_at, join_count`,
    [classId, studentId],
  );
  return rows[0];
};
