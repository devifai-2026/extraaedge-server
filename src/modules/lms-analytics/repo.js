import { tenantQuery } from '../../db/tenant.js';

// Branch scoping: LMS entities (programs/classes/batches) are tenant-wide, so
// the meaningful branch dimension is the STUDENT (via admission→lead.branch_id)
// and, for trainer hours, the trainer's own users.branch_id. When branchId is
// null the queries are tenant-wide (unchanged, super_admin all-branches).
// A student is "in branch $n" via this EXISTS on their admission's lead.
const studentInBranch = (alias, n) =>
  `EXISTS (SELECT 1 FROM admissions ad JOIN leads l ON l.id = ad.lead_id WHERE ad.id = ${alias}.admission_id AND l.branch_id = $${n})`;

// Per-course rollup for the admin LMS dashboard. Student count + score/attendance
// averages are branch-scoped (to that branch's students); classes/batches/
// trainers stay course-level (tenant-wide entities).
export const courseSummary = async (tenant, branchId = null) => {
  const p = branchId ? [branchId] : [];
  const sBranch = branchId ? ` AND ${studentInBranch('s', 1)}` : '';
  // For per-course avgs, restrict the attempt/submission/attendance to this
  // branch's students when a branch is in force.
  const attBranch = branchId ? ` AND ${studentInBranch('sa', 1)}` : '';
  const prBranch = branchId ? ` AND ${studentInBranch('sp', 1)}` : '';
  const atnBranch = branchId ? ` AND ${studentInBranch('sat', 1)}` : '';
  const { rows } = await tenantQuery(
    tenant,
    `SELECT p.id AS program_id, p.name,
            (SELECT count(*)::int FROM students s WHERE s.program_id = p.id AND s.deleted_at IS NULL${sBranch}) AS students,
            (SELECT count(*)::int FROM batches b WHERE b.program_id = p.id AND b.deleted_at IS NULL AND b.status <> 'merged') AS batches,
            (SELECT count(*)::int FROM course_trainers ct WHERE ct.program_id = p.id AND ct.deleted_at IS NULL) AS trainers,
            (SELECT count(*)::int FROM classes c WHERE c.program_id = p.id AND c.deleted_at IS NULL) AS classes,
            (SELECT round(avg(a.score),1) FROM mock_test_attempts a JOIN mock_tests t ON t.id=a.test_id ${branchId ? 'JOIN students sa ON sa.id=a.student_id' : ''} WHERE t.program_id=p.id${attBranch}) AS avg_test_score,
            (SELECT round(avg(ps.marks),1) FROM project_submissions ps JOIN projects pr ON pr.id=ps.project_id ${branchId ? 'JOIN students sp ON sp.id=ps.student_id' : ''} WHERE pr.program_id=p.id AND ps.marks IS NOT NULL${prBranch}) AS avg_project_marks,
            (SELECT round(100.0 * count(*) FILTER (WHERE att.status='present') / NULLIF(count(*),0), 1)
               FROM attendance att JOIN classes c ON c.id=att.class_id ${branchId ? 'JOIN students sat ON sat.id=att.student_id' : ''} WHERE c.program_id=p.id${atnBranch}) AS attendance_pct
       FROM programs p
      WHERE p.deleted_at IS NULL AND p.is_active = true
        AND EXISTS (SELECT 1 FROM course_trainers ct WHERE ct.program_id = p.id AND ct.deleted_at IS NULL)
      ORDER BY p.name`,
    p,
  );
  return rows;
};

// LMS totals (headline cards). Student counts branch-scoped; recordings/class
// counts stay tenant-wide (no branch dimension on those entities).
export const totals = async (tenant, branchId = null) => {
  const p = branchId ? [branchId] : [];
  const sBranch = branchId ? ` AND ${studentInBranch('s', 1)}` : '';
  const { rows } = await tenantQuery(
    tenant,
    `SELECT
        (SELECT count(*)::int FROM students s WHERE s.deleted_at IS NULL${sBranch}) AS students,
        (SELECT count(*)::int FROM students s WHERE s.deleted_at IS NULL AND s.status='active'${sBranch}) AS active_students,
        (SELECT count(*)::int FROM classes WHERE deleted_at IS NULL) AS classes,
        (SELECT count(*)::int FROM class_recordings WHERE deleted_at IS NULL) AS recordings,
        (SELECT count(*)::int FROM course_trainers WHERE deleted_at IS NULL) AS trainer_assignments`,
    p,
  );
  return rows[0];
};

// Trainer teaching hours (from class start→end) + classes taught. Branch-scoped
// by the trainer's own primary branch.
export const trainerHours = async (tenant, branchId = null) => {
  const p = branchId ? [branchId] : [];
  const uBranch = branchId ? ' AND u.branch_id = $1' : '';
  const { rows } = await tenantQuery(
    tenant,
    `SELECT u.id AS user_id, u.name,
            count(DISTINCT ta.class_id)::int AS classes_run,
            round(COALESCE(sum(EXTRACT(EPOCH FROM (c.ended_at - c.started_at)))/3600.0, 0)::numeric, 1) AS hours
       FROM trainer_attendance ta
       JOIN users u ON u.id = ta.trainer_id
       JOIN classes c ON c.id = ta.class_id AND c.started_at IS NOT NULL AND c.ended_at IS NOT NULL
      WHERE ta.action = 'class_started'${uBranch}
      GROUP BY u.id, u.name
      ORDER BY hours DESC`,
    p,
  );
  return rows;
};

// Course-confirm funnel. Approved/course-confirmed count admissions in the
// branch (via lead); activated counts that branch's active students.
export const funnel = async (tenant, branchId = null) => {
  const p = branchId ? [branchId] : [];
  const aBranch = branchId ? ' AND EXISTS (SELECT 1 FROM leads l WHERE l.id = a.lead_id AND l.branch_id = $1)' : '';
  const sBranch = branchId ? ` AND ${studentInBranch('s', 1)}` : '';
  const { rows } = await tenantQuery(
    tenant,
    `SELECT
        (SELECT count(*)::int FROM admissions a WHERE a.deleted_at IS NULL AND a.status IN ('attending','on_break','completed')${aBranch}) AS approved,
        (SELECT count(*)::int FROM admissions a WHERE a.deleted_at IS NULL AND a.course_confirmed_at IS NOT NULL${aBranch}) AS course_confirmed,
        (SELECT count(*)::int FROM students s WHERE s.deleted_at IS NULL AND s.status='active'${sBranch}) AS activated`,
    p,
  );
  return rows[0];
};

// Students for the sudo-login picker (admin). Branch-scoped for a branch_manager.
export const studentsForPicker = async (tenant, branchId = null) => {
  const p = branchId ? [branchId] : [];
  const sBranch = branchId ? ` AND ${studentInBranch('s', 1)}` : '';
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.name, s.email, s.status, p.name AS program_name
       FROM students s LEFT JOIN programs p ON p.id = s.program_id
      WHERE s.deleted_at IS NULL${sBranch} ORDER BY s.name LIMIT 500`,
    p,
  );
  return rows;
};
