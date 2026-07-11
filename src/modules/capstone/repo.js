// Course-level capstone projects + submissions. Pure tenantQuery SQL.
import { tenantQuery } from '../../db/tenant.js';

export const list = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.program_id, c.batch_id, b.name AS batch_name, c.title, c.brief, c.marking_scheme, c.max_marks, c.deadline, c.created_at,
            (SELECT count(*)::int FROM capstone_submissions s WHERE s.capstone_id = c.id) AS submission_count,
            (SELECT count(*)::int FROM capstone_submissions s WHERE s.capstone_id = c.id AND s.marks IS NOT NULL) AS graded_count
       FROM capstone_projects c
       LEFT JOIN batches b ON b.id = c.batch_id
      WHERE c.program_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.created_at DESC`,
    [programId],
  );
  return rows;
};

export const get = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM capstone_projects WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] || null;
};

export const create = async (tenant, input, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO capstone_projects (program_id, batch_id, title, brief, marking_scheme, max_marks, deadline, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.program_id, input.batch_id ?? null, input.title, input.brief ?? null, input.marking_scheme ?? null, input.max_marks ?? 100, input.deadline ?? null, actorId ?? null],
  );
  return rows[0];
};

export const softDelete = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE capstone_projects SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
};

export const listSubmissions = async (tenant, capstoneId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.student_id, st.name, st.email, s.live_url, s.github_url, s.file_r2_key, s.marks, s.feedback, s.submitted_at
       FROM capstone_submissions s JOIN students st ON st.id = s.student_id
      WHERE s.capstone_id = $1 ORDER BY st.name`,
    [capstoneId],
  );
  return rows;
};

export const submissionById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.*, c.program_id, c.max_marks FROM capstone_submissions s JOIN capstone_projects c ON c.id = s.capstone_id WHERE s.id = $1`,
    [id],
  );
  return rows[0] || null;
};

export const grade = async (tenant, submissionId, marks, feedback, graderId) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE capstone_submissions SET marks = $2, feedback = $3, graded_by = $4, graded_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [submissionId, marks, feedback ?? null, graderId ?? null],
  );
  return rows[0] || null;
};

// ---------- Student ----------
export const studentProgram = async (tenant, studentId) => {
  const { rows } = await tenantQuery(tenant, `SELECT program_id FROM students WHERE id = $1 AND deleted_at IS NULL`, [studentId]);
  return rows[0]?.program_id || null;
};

// A student's capstones (for their program) with their own submission attached.
export const studentCapstones = async (tenant, studentId, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.title, c.brief, c.marking_scheme, c.max_marks, c.deadline,
            s.id AS submission_id, s.live_url, s.github_url, s.file_r2_key, s.marks, s.feedback, s.submitted_at
       FROM capstone_projects c
       LEFT JOIN capstone_submissions s ON s.capstone_id = c.id AND s.student_id = $1
      WHERE c.program_id = $2 AND c.deleted_at IS NULL
        AND (c.batch_id IS NULL OR c.batch_id IN (
              SELECT bs.batch_id FROM batch_students bs
               WHERE bs.student_id = $1 AND bs.deleted_at IS NULL))
      ORDER BY c.created_at DESC`,
    [studentId, programId],
  );
  return rows;
};

export const submit = async (tenant, capstoneId, studentId, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO capstone_submissions (capstone_id, student_id, live_url, github_url, file_r2_key)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (capstone_id, student_id) DO UPDATE
       SET live_url = EXCLUDED.live_url, github_url = EXCLUDED.github_url,
           file_r2_key = COALESCE(EXCLUDED.file_r2_key, capstone_submissions.file_r2_key),
           submitted_at = now(), updated_at = now()
     RETURNING *`,
    [capstoneId, studentId, input.live_url ?? null, input.github_url ?? null, input.file_r2_key ?? null],
  );
  return rows[0];
};
