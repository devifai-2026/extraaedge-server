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
            (SELECT count(*)::int FROM interview_slots s WHERE s.interview_id = i.id AND s.deleted_at IS NULL AND s.marks IS NOT NULL) AS graded_count
       FROM mock_interviews i
      WHERE i.program_id = $1 AND i.deleted_at IS NULL ORDER BY i.created_at DESC`,
    [programId],
  );
  return rows;
};

export const get = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM mock_interviews WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] || null;
};

export const listSlots = async (tenant, interviewId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.student_id, st.name, s.slot_at, s.marks, s.feedback
       FROM interview_slots s JOIN students st ON st.id = s.student_id
      WHERE s.interview_id = $1 AND s.deleted_at IS NULL ORDER BY s.slot_at NULLS LAST, st.name`,
    [interviewId],
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
    `SELECT s.id, i.title, i.meeting_url, s.slot_at, s.marks, s.feedback, i.max_marks
       FROM interview_slots s JOIN mock_interviews i ON i.id = s.interview_id
      WHERE s.student_id = $1 AND s.deleted_at IS NULL AND i.deleted_at IS NULL
      ORDER BY s.slot_at NULLS LAST`,
    [studentId],
  );
  return rows;
};
