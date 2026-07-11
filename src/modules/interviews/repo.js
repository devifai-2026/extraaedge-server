import { tenantQuery } from '../../db/tenant.js';

export const create = async (tenant, input, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO mock_interviews (program_id, title, meeting_url, max_marks, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [input.program_id, input.title, input.meeting_url ?? null, input.max_marks ?? 100, actorId ?? null],
  );
  return rows[0];
};

export const list = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT i.id, i.title, i.meeting_url, i.max_marks, i.created_at,
            (SELECT count(*)::int FROM interview_slots s WHERE s.interview_id = i.id AND s.deleted_at IS NULL) AS slot_count,
            (SELECT count(*)::int FROM interview_slots s WHERE s.interview_id = i.id AND s.deleted_at IS NULL AND s.graded_at IS NOT NULL) AS graded_count
       FROM mock_interviews i
      WHERE i.program_id = $1 AND i.deleted_at IS NULL ORDER BY i.created_at DESC`,
    [programId],
  );
  return rows;
};

export const get = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT i.*, u.name AS hr_user_name FROM mock_interviews i
       LEFT JOIN users u ON u.id = i.hr_user_id
      WHERE i.id = $1 AND i.deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
};

// ---------- Rubric categories ----------
export const addCategories = async (tenant, interviewId, categories) => {
  for (let idx = 0; idx < categories.length; idx += 1) {
    const c = categories[idx];
    // eslint-disable-next-line no-await-in-loop
    await tenantQuery(
      tenant,
      `INSERT INTO interview_categories (interview_id, name, max_marks, scored_by, order_index)
       VALUES ($1,$2,$3,$4,$5)`,
      [interviewId, c.name, c.max_marks ?? 10, c.scored_by === 'hr' ? 'hr' : 'trainer', idx],
    );
  }
};

export const listCategories = async (tenant, interviewId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, max_marks, scored_by, order_index FROM interview_categories
      WHERE interview_id = $1 ORDER BY order_index, name`,
    [interviewId],
  );
  return rows;
};

export const categoryById = async (tenant, categoryId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.*, i.program_id, i.hr_user_id FROM interview_categories c
       JOIN mock_interviews i ON i.id = c.interview_id WHERE c.id = $1`,
    [categoryId],
  );
  return rows[0] || null;
};

export const setHrEvaluator = async (tenant, interviewId, hrUserId) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE mock_interviews SET hr_user_id = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [interviewId, hrUserId ?? null],
  );
  return rows[0] || null;
};

// Upsert one category score for a slot; then recompute the slot roll-up total.
export const upsertSlotScore = async (tenant, slotId, categoryId, marks, userId) => {
  await tenantQuery(
    tenant,
    `INSERT INTO interview_slot_scores (slot_id, category_id, marks, scored_by_user)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (slot_id, category_id) DO UPDATE SET marks = EXCLUDED.marks, scored_by_user = EXCLUDED.scored_by_user, updated_at = now()`,
    [slotId, categoryId, marks, userId ?? null],
  );
};

// Recompute the slot roll-up. `marks` always reflects the running sum so graders
// see progress, but the slot is only FINALIZED (graded_at set) once every rubric
// category has a score — a slot with the HR soft-skill category still pending
// stays graded_at = NULL and is excluded from the leaderboard (see
// finalizedInterviewMarks). If a category is later cleared, graded_at reverts.
export const recomputeSlotTotal = async (tenant, slotId, graderId) => {
  const { rows } = await tenantQuery(
    tenant,
    `WITH cats AS (
       SELECT count(*)::int AS total
         FROM interview_categories c
         JOIN interview_slots s ON s.id = $1
        WHERE c.interview_id = s.interview_id
     ), scored AS (
       SELECT count(*)::int AS done FROM interview_slot_scores WHERE slot_id = $1
     )
     UPDATE interview_slots s SET
        marks = COALESCE((SELECT sum(marks) FROM interview_slot_scores WHERE slot_id = $1), 0),
        graded_by = $2,
        graded_at = CASE WHEN (SELECT total FROM cats) > 0 AND (SELECT done FROM scored) >= (SELECT total FROM cats) THEN now() ELSE NULL END,
        updated_at = now()
      WHERE s.id = $1 AND s.deleted_at IS NULL RETURNING *`,
    [slotId, graderId ?? null],
  );
  return rows[0] || null;
};

export const slotScores = async (tenant, slotId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT sc.category_id, sc.marks, c.name, c.max_marks, c.scored_by
       FROM interview_slot_scores sc JOIN interview_categories c ON c.id = sc.category_id
      WHERE sc.slot_id = $1 ORDER BY c.order_index`,
    [slotId],
  );
  return rows;
};

// Interviews an HR user is the assigned evaluator on.
export const listForHr = async (tenant, hrUserId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT i.id, i.title, i.meeting_url, i.max_marks, i.program_id, p.name AS program_name, i.created_at,
            (SELECT count(*)::int FROM interview_slots s WHERE s.interview_id = i.id AND s.deleted_at IS NULL) AS slot_count
       FROM mock_interviews i LEFT JOIN programs p ON p.id = i.program_id
      WHERE i.hr_user_id = $1 AND i.deleted_at IS NULL ORDER BY i.created_at DESC`,
    [hrUserId],
  );
  return rows;
};

export const listSlots = async (tenant, interviewId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.student_id, st.name, s.slot_at, s.marks, s.feedback, s.graded_at
       FROM interview_slots s JOIN students st ON st.id = s.student_id
      WHERE s.interview_id = $1 AND s.deleted_at IS NULL ORDER BY s.slot_at NULLS LAST, st.name`,
    [interviewId],
  );
  return rows;
};

// Per-student SUM of interview marks for a program, counting ONLY finalized
// slots (graded_at IS NOT NULL — all rubric categories scored, or a flat grade).
// Used by the leaderboard so a slot awaiting HR soft-skill scores doesn't count.
export const finalizedInterviewMarks = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.student_id, COALESCE(sum(s.marks),0)::numeric AS m
       FROM interview_slots s
       JOIN mock_interviews i ON i.id = s.interview_id
      WHERE i.program_id = $1 AND i.deleted_at IS NULL AND s.deleted_at IS NULL
        AND s.graded_at IS NOT NULL AND s.marks IS NOT NULL
      GROUP BY s.student_id`,
    [programId],
  );
  return rows;
};

export const assignSlot = async (tenant, interviewId, studentId, slotAt) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO interview_slots (interview_id, student_id, slot_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (interview_id, student_id) WHERE deleted_at IS NULL DO UPDATE SET slot_at = EXCLUDED.slot_at, updated_at = now()
     RETURNING *`,
    [interviewId, studentId, slotAt ?? null],
  );
  return rows[0];
};

export const gradeSlot = async (tenant, slotId, marks, feedback, graderId) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE interview_slots SET marks = $2, feedback = $3, graded_by = $4, graded_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [slotId, marks, feedback ?? null, graderId ?? null],
  );
  return rows[0] || null;
};

export const slotById = async (tenant, slotId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.*, i.program_id FROM interview_slots s JOIN mock_interviews i ON i.id = s.interview_id WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [slotId],
  );
  return rows[0] || null;
};

export const studentProgram = async (tenant, studentId) => {
  const { rows } = await tenantQuery(tenant, `SELECT program_id FROM students WHERE id = $1 AND deleted_at IS NULL`, [studentId]);
  return rows[0]?.program_id || null;
};

// HR users to pick as the interview's soft-skill evaluator.
export const assignableHr = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, email FROM users WHERE role = 'hr' AND is_active = true AND deleted_at IS NULL ORDER BY name`,
    [],
  );
  return rows;
};

// Students of a program (for the assign picker).
export const programStudents = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, email FROM students WHERE program_id = $1 AND deleted_at IS NULL ORDER BY name`,
    [programId],
  );
  return rows;
};

// A student's own interview slots.
export const studentSlots = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.interview_id, i.title, i.meeting_url, s.slot_at, s.marks, s.feedback, s.graded_at, i.max_marks
       FROM interview_slots s JOIN mock_interviews i ON i.id = s.interview_id
      WHERE s.student_id = $1 AND s.deleted_at IS NULL AND i.deleted_at IS NULL
      ORDER BY s.slot_at NULLS LAST`,
    [studentId],
  );
  return rows;
};
