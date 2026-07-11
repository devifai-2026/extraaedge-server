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

// Students in a course with whether they've completed a given module.
export const studentsWithModuleCompletion = async (tenant, programId, moduleId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id AS student_id, s.name, s.email,
            (smp.id IS NOT NULL) AS completed,
            (SELECT b.name FROM batch_students bs JOIN batches b ON b.id = bs.batch_id
              WHERE bs.student_id = s.id AND bs.deleted_at IS NULL ORDER BY bs.joined_at DESC LIMIT 1) AS batch_name
       FROM students s
       LEFT JOIN student_module_progress smp ON smp.student_id = s.id AND smp.module_id = $2
      WHERE s.program_id = $1 AND s.deleted_at IS NULL
      ORDER BY s.name`,
    [programId, moduleId],
  );
  return rows;
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

// HR dashboard KPIs. Guarded with to_regclass so it works before the interview/
// certificate migrations. `hrUserId` scopes the interview queue to that HR; when
// null (admin) it counts every not-yet-finalized assigned slot. Certificates +
// completion pipeline are tenant-wide (branch scoping for HR is a later pass).
export const hrCounts = async (tenant, hrUserId = null) => {
  const has = await tenantQuery(
    tenant,
    `SELECT to_regclass('interview_slots') IS NOT NULL AS iv,
            to_regclass('certificates') IS NOT NULL AS certs,
            to_regclass('student_module_progress') IS NOT NULL AS smp`,
    [],
  );
  const { iv, certs, smp } = has.rows[0] || {};

  let interviews_to_score = 0;
  if (iv) {
    // Slots on interviews this HR evaluates that aren't finalized yet
    // (graded_at NULL = a rubric category still pending, incl. the HR's own).
    const params = [];
    let hrCond = '';
    if (hrUserId) { params.push(hrUserId); hrCond = `AND i.hr_user_id = $${params.length}`; }
    else hrCond = 'AND i.hr_user_id IS NOT NULL';
    const r = await tenantQuery(
      tenant,
      `SELECT count(*)::int AS n
         FROM interview_slots s
         JOIN mock_interviews i ON i.id = s.interview_id AND i.deleted_at IS NULL
        WHERE s.deleted_at IS NULL AND s.graded_at IS NULL ${hrCond}`,
      params,
    );
    interviews_to_score = r.rows[0]?.n || 0;
  }

  let certificates_issued = 0;
  if (certs) {
    const r = await tenantQuery(tenant, `SELECT count(*)::int AS n FROM certificates`, []);
    certificates_issued = r.rows[0]?.n || 0;
  }

  // Completion pipeline: active students who have completed EVERY module of
  // their program but don't have a certificate yet (i.e. awaiting issuance /
  // attendance). Only meaningful once module progress + certs exist.
  let completion_pipeline = 0;
  if (smp && certs) {
    const r = await tenantQuery(
      tenant,
      `SELECT count(*)::int AS n FROM students s
        WHERE s.deleted_at IS NULL AND s.status = 'active' AND s.program_id IS NOT NULL
          AND (SELECT count(*) FROM course_modules m WHERE m.program_id = s.program_id AND m.deleted_at IS NULL) > 0
          AND NOT EXISTS (
            SELECT 1 FROM course_modules m
             WHERE m.program_id = s.program_id AND m.deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM student_module_progress smp2 WHERE smp2.student_id = s.id AND smp2.module_id = m.id))
          AND NOT EXISTS (SELECT 1 FROM certificates c WHERE c.student_id = s.id AND c.program_id = s.program_id)`,
      [],
    );
    completion_pipeline = r.rows[0]?.n || 0;
  }

  return { interviews_to_score, certificates_issued, completion_pipeline };
};
