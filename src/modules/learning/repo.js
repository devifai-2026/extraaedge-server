// Data access for the LMS learning layer: study materials, per-module progress,
// completion certificates, and the activity streak. Pure tenantQuery SQL.
import { tenantQuery } from '../../db/tenant.js';

// ---------- Study materials ----------
export const listMaterials = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT cm.id, cm.program_id, cm.module_id, cm.title, cm.description, cm.kind,
            cm.url, cm.file_name, cm.content_type, cm.size_bytes, cm.created_at,
            m.name AS module_name, m.order_index AS module_order,
            u.name AS uploaded_by_name
       FROM course_materials cm
       LEFT JOIN course_modules m ON m.id = cm.module_id
       LEFT JOIN users u ON u.id = cm.uploaded_by
      WHERE cm.program_id = $1 AND cm.deleted_at IS NULL
      ORDER BY m.order_index NULLS FIRST, cm.created_at DESC`,
    [programId],
  );
  return rows;
};

export const getMaterial = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, program_id, module_id, title, kind, r2_key, url, file_name, content_type
       FROM course_materials WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
};

export const createMaterial = async (tenant, input, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO course_materials
       (program_id, module_id, title, description, kind, r2_key, url, file_name, content_type, size_bytes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [input.program_id, input.module_id ?? null, input.title, input.description ?? null, input.kind,
      input.r2_key ?? null, input.url ?? null, input.file_name ?? null, input.content_type ?? null,
      input.size_bytes ?? null, actorId ?? null],
  );
  return rows[0];
};

export const softDeleteMaterial = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE course_materials SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
};

// ---------- Per-module progress ----------
export const completedModuleIds = async (tenant, studentId, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT module_id FROM student_module_progress WHERE student_id = $1 AND program_id = $2`,
    [studentId, programId],
  );
  return rows.map((r) => r.module_id);
};

export const markModule = async (tenant, studentId, programId, moduleId) => {
  await tenantQuery(
    tenant,
    `INSERT INTO student_module_progress (student_id, program_id, module_id)
     VALUES ($1,$2,$3) ON CONFLICT (student_id, module_id) DO NOTHING`,
    [studentId, programId, moduleId],
  );
};

export const unmarkModule = async (tenant, studentId, moduleId) => {
  await tenantQuery(tenant, `DELETE FROM student_module_progress WHERE student_id = $1 AND module_id = $2`, [studentId, moduleId]);
};

// Trainer insight: per-module completion counts across the course's students.
export const progressByModule = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT m.id AS module_id, m.name, m.order_index,
            (SELECT count(*) FROM student_module_progress smp WHERE smp.module_id = m.id) AS completed_count
       FROM course_modules m
      WHERE m.program_id = $1 AND m.deleted_at IS NULL
      ORDER BY m.order_index, m.created_at`,
    [programId],
  );
  const { rows: st } = await tenantQuery(tenant, `SELECT count(*)::int AS n FROM students WHERE program_id = $1 AND deleted_at IS NULL`, [programId]);
  return { modules: rows, total_students: st[0]?.n || 0 };
};

// ---------- Certificates ----------
export const getCertificate = async (tenant, studentId, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, student_id, program_id, certificate_number, issued_by, meta, issued_at
       FROM certificates WHERE student_id = $1 AND program_id = $2 AND deleted_at IS NULL`,
    [studentId, programId],
  );
  return rows[0] || null;
};

export const countCertificates = async (tenant, programId) => {
  const { rows } = await tenantQuery(tenant, `SELECT count(*)::int AS n FROM certificates WHERE program_id = $1`, [programId]);
  return rows[0]?.n || 0;
};

export const insertCertificate = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO certificates (student_id, program_id, certificate_number, issued_by, meta)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (student_id, program_id) WHERE deleted_at IS NULL DO NOTHING
     RETURNING id, certificate_number, issued_at, meta, issued_by`,
    [input.student_id, input.program_id, input.certificate_number, input.issued_by ?? null, JSON.stringify(input.meta ?? {})],
  );
  return rows[0] || null;
};

export const listCertificates = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.certificate_number, c.issued_at, c.meta, c.student_id,
            s.name AS student_name, s.email AS student_email,
            u.name AS issued_by_name
       FROM certificates c
       JOIN students s ON s.id = c.student_id
       LEFT JOIN users u ON u.id = c.issued_by
      WHERE c.program_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.issued_at DESC`,
    [programId],
  );
  return rows;
};

// ---------- Activity streak ----------
export const pingActivity = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO student_activity (student_id, last_active_date, current_streak, longest_streak)
     VALUES ($1, CURRENT_DATE, 1, 1)
     ON CONFLICT (student_id) DO UPDATE SET
       current_streak = CASE
         WHEN student_activity.last_active_date = CURRENT_DATE THEN student_activity.current_streak
         WHEN student_activity.last_active_date = CURRENT_DATE - 1 THEN student_activity.current_streak + 1
         ELSE 1 END,
       longest_streak = GREATEST(student_activity.longest_streak, CASE
         WHEN student_activity.last_active_date = CURRENT_DATE THEN student_activity.current_streak
         WHEN student_activity.last_active_date = CURRENT_DATE - 1 THEN student_activity.current_streak + 1
         ELSE 1 END),
       last_active_date = CURRENT_DATE,
       updated_at = now()
     RETURNING current_streak, longest_streak`,
    [studentId],
  );
  return rows[0] || { current_streak: 0, longest_streak: 0 };
};

// ---------- Shared context (student identity + program) ----------
export const getStudentContext = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.name, s.email, s.program_id, s.photo_r2_key, s.cv_r2_key, s.bio,
            p.name AS program_name
       FROM students s
       LEFT JOIN programs p ON p.id = s.program_id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [studentId],
  );
  return rows[0] || null;
};

export const studentsInProgram = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, email FROM students WHERE program_id = $1 AND deleted_at IS NULL ORDER BY name`,
    [programId],
  );
  return rows;
};
