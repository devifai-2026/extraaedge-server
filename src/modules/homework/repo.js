import { tenantQuery } from '../../db/tenant.js';

// ---------- Trainer/admin ----------
export const list = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT a.id, a.title, a.brief, a.deadline, a.max_marks, m.name AS module_name,
            (SELECT count(*)::int FROM assignment_submissions s WHERE s.assignment_id = a.id) AS submission_count,
            (SELECT count(*)::int FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.marks IS NOT NULL) AS graded_count
       FROM assignments a LEFT JOIN course_modules m ON m.id = a.module_id
      WHERE a.program_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at DESC`,
    [programId],
  );
  return rows;
};

export const create = async (tenant, input, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO assignments (program_id, module_id, title, brief, deadline, max_marks, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.program_id, input.module_id ?? null, input.title, input.brief ?? null, input.deadline ?? null, input.max_marks ?? 10, actorId ?? null],
  );
  return rows[0];
};

export const softDelete = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE assignments SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
};

export const getById = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM assignments WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] || null;
};

export const listSubmissions = async (tenant, assignmentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT sub.id, sub.student_id, st.name, sub.file_r2_key, sub.notes, sub.marks, sub.feedback, sub.submitted_at
       FROM assignment_submissions sub JOIN students st ON st.id = sub.student_id
      WHERE sub.assignment_id = $1 ORDER BY st.name`,
    [assignmentId],
  );
  return rows;
};

export const grade = async (tenant, submissionId, marks, feedback, graderId) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE assignment_submissions SET marks = $2, feedback = $3, graded_by = $4, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [submissionId, marks, feedback ?? null, graderId ?? null],
  );
  return rows[0] || null;
};

// Submission with its assignment's program_id + max_marks (for grading guards).
export const submissionById = async (tenant, submissionId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT sub.*, a.program_id, a.max_marks
       FROM assignment_submissions sub JOIN assignments a ON a.id = sub.assignment_id
      WHERE sub.id = $1`,
    [submissionId],
  );
  return rows[0] || null;
};

// ---------- Student ----------
export const studentAssignments = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT a.id, a.title, a.brief, a.deadline, a.max_marks, m.name AS module_name,
            sub.file_r2_key, sub.notes, sub.marks, sub.feedback, sub.submitted_at
       FROM students s
       JOIN assignments a ON a.program_id = s.program_id AND a.deleted_at IS NULL
       LEFT JOIN course_modules m ON m.id = a.module_id
       LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id AND sub.student_id = s.id
      WHERE s.id = $1 AND s.deleted_at IS NULL
      ORDER BY a.deadline NULLS LAST, a.created_at DESC`,
    [studentId],
  );
  return rows;
};

export const submit = async (tenant, assignmentId, studentId, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO assignment_submissions (assignment_id, student_id, file_r2_key, notes, submitted_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (assignment_id, student_id)
       DO UPDATE SET file_r2_key = COALESCE(EXCLUDED.file_r2_key, assignment_submissions.file_r2_key),
                     notes = EXCLUDED.notes, submitted_at = now(), updated_at = now()
     RETURNING *`,
    [assignmentId, studentId, input.file_r2_key ?? null, input.notes ?? null],
  );
  return rows[0];
};

export const studentProgram = async (tenant, studentId) => {
  const { rows } = await tenantQuery(tenant, `SELECT program_id FROM students WHERE id = $1 AND deleted_at IS NULL`, [studentId]);
  return rows[0]?.program_id || null;
};
