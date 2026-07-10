import { tenantQuery } from '../../db/tenant.js';

// Per-course rollup for the admin LMS dashboard.
export const courseSummary = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT p.id AS program_id, p.name,
            (SELECT count(*)::int FROM students s WHERE s.program_id = p.id AND s.deleted_at IS NULL) AS students,
            (SELECT count(*)::int FROM batches b WHERE b.program_id = p.id AND b.deleted_at IS NULL AND b.status <> 'merged') AS batches,
            (SELECT count(*)::int FROM course_trainers ct WHERE ct.program_id = p.id AND ct.deleted_at IS NULL) AS trainers,
            (SELECT count(*)::int FROM classes c WHERE c.program_id = p.id AND c.deleted_at IS NULL) AS classes,
            (SELECT round(avg(a.score),1) FROM mock_test_attempts a JOIN mock_tests t ON t.id=a.test_id WHERE t.program_id=p.id) AS avg_test_score,
            (SELECT round(avg(ps.marks),1) FROM project_submissions ps JOIN projects pr ON pr.id=ps.project_id WHERE pr.program_id=p.id AND ps.marks IS NOT NULL) AS avg_project_marks,
            (SELECT round(100.0 * count(*) FILTER (WHERE att.status='present') / NULLIF(count(*),0), 1)
               FROM attendance att JOIN classes c ON c.id=att.class_id WHERE c.program_id=p.id) AS attendance_pct
       FROM programs p
      WHERE p.deleted_at IS NULL AND p.is_active = true
        AND EXISTS (SELECT 1 FROM course_trainers ct WHERE ct.program_id = p.id AND ct.deleted_at IS NULL)
      ORDER BY p.name`,
  );
  return rows;
};

// Tenant-wide LMS totals (headline cards).
export const totals = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT
        (SELECT count(*)::int FROM students WHERE deleted_at IS NULL) AS students,
        (SELECT count(*)::int FROM students WHERE deleted_at IS NULL AND status='active') AS active_students,
        (SELECT count(*)::int FROM classes WHERE deleted_at IS NULL) AS classes,
        (SELECT count(*)::int FROM class_recordings WHERE deleted_at IS NULL) AS recordings,
        (SELECT count(*)::int FROM course_trainers WHERE deleted_at IS NULL) AS trainer_assignments`,
  );
  return rows[0];
};

// Trainer teaching hours (from class start→end) + classes taught.
export const trainerHours = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT u.id AS user_id, u.name,
            count(DISTINCT ta.class_id)::int AS classes_run,
            round(COALESCE(sum(EXTRACT(EPOCH FROM (c.ended_at - c.started_at)))/3600.0, 0)::numeric, 1) AS hours
       FROM trainer_attendance ta
       JOIN users u ON u.id = ta.trainer_id
       JOIN classes c ON c.id = ta.class_id AND c.started_at IS NOT NULL AND c.ended_at IS NOT NULL
      WHERE ta.action = 'class_started'
      GROUP BY u.id, u.name
      ORDER BY hours DESC`,
  );
  return rows;
};

// Course-confirm funnel: approved admissions vs course-confirmed vs students
// who actually activated (set a password).
export const funnel = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT
        (SELECT count(*)::int FROM admissions WHERE deleted_at IS NULL AND status IN ('attending','on_break','completed')) AS approved,
        (SELECT count(*)::int FROM admissions WHERE deleted_at IS NULL AND course_confirmed_at IS NOT NULL) AS course_confirmed,
        (SELECT count(*)::int FROM students WHERE deleted_at IS NULL AND status='active') AS activated`,
  );
  return rows[0];
};

// Students for the sudo-login picker (admin).
export const studentsForPicker = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.name, s.email, s.status, p.name AS program_name
       FROM students s LEFT JOIN programs p ON p.id = s.program_id
      WHERE s.deleted_at IS NULL ORDER BY s.name LIMIT 500`,
  );
  return rows;
};
