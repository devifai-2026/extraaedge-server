import { tenantQuery } from '../../db/tenant.js';

// ---------- Mock tests ----------
export const createTest = async (tenant, input, actorId) => {
  const total = (input.questions || []).reduce((s, q) => s + (Number(q.marks) || 0), 0);
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO mock_tests (program_id, module_id, title, questions, total_marks, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.program_id, input.module_id ?? null, input.title, JSON.stringify(input.questions ?? []), total, actorId ?? null],
  );
  return rows[0];
};

export const listTests = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT t.id, t.title, t.total_marks, t.is_published, t.created_at, m.name AS module_name,
            (SELECT count(*)::int FROM mock_test_attempts a WHERE a.test_id = t.id) AS attempt_count
       FROM mock_tests t LEFT JOIN course_modules m ON m.id = t.module_id
      WHERE t.program_id = $1 AND t.deleted_at IS NULL ORDER BY t.created_at DESC`,
    [programId],
  );
  return rows;
};

export const getTest = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM mock_tests WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] || null;
};

export const testResults = async (tenant, testId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT a.student_id, s.name, a.score, a.submitted_at
       FROM mock_test_attempts a JOIN students s ON s.id = a.student_id
      WHERE a.test_id = $1 ORDER BY a.score DESC, a.submitted_at`,
    [testId],
  );
  return rows;
};

export const recordAttempt = async (tenant, testId, studentId, answers, score) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO mock_test_attempts (test_id, student_id, answers, score)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (test_id, student_id) DO NOTHING
     RETURNING *`,
    [testId, studentId, JSON.stringify(answers), score],
  );
  return rows[0] || null; // null => already attempted
};

export const studentAttempt = async (tenant, testId, studentId) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM mock_test_attempts WHERE test_id = $1 AND student_id = $2`, [testId, studentId]);
  return rows[0] || null;
};

// Student's tests (published) for their program, with their attempt score.
export const studentTests = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT t.id, t.title, t.total_marks, m.name AS module_name,
            a.score AS my_score, a.submitted_at AS my_submitted_at
       FROM students s
       JOIN mock_tests t ON t.program_id = s.program_id AND t.deleted_at IS NULL AND t.is_published = true
       LEFT JOIN course_modules m ON m.id = t.module_id
       LEFT JOIN mock_test_attempts a ON a.test_id = t.id AND a.student_id = s.id
      WHERE s.id = $1 AND s.deleted_at IS NULL
      ORDER BY t.created_at DESC`,
    [studentId],
  );
  return rows;
};

// A test WITHOUT correct answers, for a student taking it.
export const studentTakeTest = async (tenant, testId, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT t.id, t.title, t.total_marks, t.questions
       FROM mock_tests t JOIN students s ON s.id = $2 AND s.program_id = t.program_id
      WHERE t.id = $1 AND t.deleted_at IS NULL AND t.is_published = true`,
    [testId, studentId],
  );
  const t = rows[0];
  if (!t) return null;
  // Strip correct_index from each question.
  const questions = (t.questions || []).map((q) => ({ q: q.q, options: q.options, marks: q.marks }));
  return { id: t.id, title: t.title, total_marks: t.total_marks, questions };
};

// ---------- Projects ----------
export const createProject = async (tenant, input, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO projects (program_id, module_id, title, brief, marking_scheme, max_marks, deadline, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.program_id, input.module_id ?? null, input.title, input.brief ?? null, input.marking_scheme ?? null,
     input.max_marks ?? 100, input.deadline ?? null, actorId ?? null],
  );
  return rows[0];
};

export const listProjects = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT p.id, p.title, p.brief, p.max_marks, p.deadline, m.name AS module_name,
            (SELECT count(*)::int FROM project_submissions ps WHERE ps.project_id = p.id) AS submission_count,
            (SELECT count(*)::int FROM project_submissions ps WHERE ps.project_id = p.id AND ps.marks IS NOT NULL) AS graded_count
       FROM projects p LEFT JOIN course_modules m ON m.id = p.module_id
      WHERE p.program_id = $1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC`,
    [programId],
  );
  return rows;
};

export const getProject = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] || null;
};

export const listSubmissions = async (tenant, projectId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ps.id, ps.student_id, s.name, ps.live_url, ps.github_url, ps.notes, ps.marks, ps.feedback, ps.submitted_at
       FROM project_submissions ps JOIN students s ON s.id = ps.student_id
      WHERE ps.project_id = $1 ORDER BY ps.submitted_at`,
    [projectId],
  );
  return rows;
};

export const submitProject = async (tenant, projectId, studentId, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO project_submissions (project_id, student_id, live_url, github_url, notes)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (project_id, student_id) DO UPDATE
       SET live_url = EXCLUDED.live_url, github_url = EXCLUDED.github_url, notes = EXCLUDED.notes, updated_at = now()
     RETURNING *`,
    [projectId, studentId, input.live_url ?? null, input.github_url ?? null, input.notes ?? null],
  );
  return rows[0];
};

export const gradeSubmission = async (tenant, submissionId, marks, feedback, graderId) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE project_submissions SET marks = $2, feedback = $3, graded_by = $4, graded_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [submissionId, marks, feedback ?? null, graderId ?? null],
  );
  return rows[0] || null;
};

export const studentProjects = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT p.id, p.title, p.brief, p.max_marks, p.deadline, p.marking_scheme, m.name AS module_name,
            ps.live_url, ps.github_url, ps.notes, ps.marks, ps.feedback, ps.submitted_at
       FROM students s
       JOIN projects p ON p.program_id = s.program_id AND p.deleted_at IS NULL
       LEFT JOIN course_modules m ON m.id = p.module_id
       LEFT JOIN project_submissions ps ON ps.project_id = p.id AND ps.student_id = s.id
      WHERE s.id = $1 AND s.deleted_at IS NULL
      ORDER BY p.created_at DESC`,
    [studentId],
  );
  return rows;
};

export const studentProgram = async (tenant, studentId) => {
  const { rows } = await tenantQuery(tenant, `SELECT program_id FROM students WHERE id = $1 AND deleted_at IS NULL`, [studentId]);
  return rows[0]?.program_id || null;
};

// ---------- Leaderboard (derived) ----------
// Combines: mock-test score sum, project marks sum, attendance %, and
// interview marks sum (interview_slots may not exist until Phase 7 — guard with
// to_regclass so this query works before/after that migration).
export const leaderboard = async (tenant, programId) => {
  const { rows: hasInterview } = await tenantQuery(tenant, `SELECT to_regclass('interview_slots') IS NOT NULL AS ok`, []);
  const interviewJoin = hasInterview[0]?.ok
    ? `LEFT JOIN (SELECT student_id, COALESCE(sum(marks),0) AS m FROM interview_slots WHERE marks IS NOT NULL GROUP BY student_id) iv ON iv.student_id = s.id`
    : '';
  const interviewExpr = hasInterview[0]?.ok ? 'COALESCE(iv.m,0)' : '0';
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id AS student_id, s.name,
            COALESCE(tt.m,0)::numeric AS test_score,
            COALESCE(pr.m,0)::numeric AS project_score,
            COALESCE(att.pct,0)::numeric AS attendance_pct,
            ${interviewExpr}::numeric AS interview_score,
            (COALESCE(tt.m,0) + COALESCE(pr.m,0) + ${interviewExpr} + COALESCE(att.pct,0))::numeric AS total
       FROM students s
       LEFT JOIN (SELECT a.student_id, sum(a.score) AS m FROM mock_test_attempts a JOIN mock_tests t ON t.id=a.test_id WHERE t.program_id=$1 GROUP BY a.student_id) tt ON tt.student_id = s.id
       LEFT JOIN (SELECT ps.student_id, sum(ps.marks) AS m FROM project_submissions ps JOIN projects p ON p.id=ps.project_id WHERE p.program_id=$1 AND ps.marks IS NOT NULL GROUP BY ps.student_id) pr ON pr.student_id = s.id
       LEFT JOIN (
         SELECT bs.student_id,
                round(100.0 * count(*) FILTER (WHERE att.status='present') / NULLIF(count(*),0), 1) AS pct
           FROM batch_students bs
           JOIN classes c ON c.batch_id = bs.batch_id AND c.deleted_at IS NULL AND c.program_id = $1
           LEFT JOIN attendance att ON att.class_id = c.id AND att.student_id = bs.student_id
          WHERE bs.deleted_at IS NULL
          GROUP BY bs.student_id
       ) att ON att.student_id = s.id
       ${interviewJoin}
      WHERE s.program_id = $1 AND s.deleted_at IS NULL
      ORDER BY total DESC, s.name`,
    [programId],
  );
  return rows;
};
