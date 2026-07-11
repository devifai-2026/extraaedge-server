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
// Weighted leaderboard (0–100). Each component is normalized to a 0–100 subscore
// (earned / achievable-max × 100), then combined by DEFAULT_WEIGHTS. Components
// with no achievable max in this program (e.g. no capstone defined yet) are
// dropped and the remaining weights renormalize, so an empty component never
// drags everyone to zero. Attendance uses the canonical "ended classes only"
// denominator (matches the student dashboard). Interview counts only FINALIZED
// slots (all rubric categories scored), program-scoped — fixing the prior
// cross-program leak and raw-sum-with-a-percentage bug.
//
// Guards with to_regclass so it works before/after the interview + capstone
// migrations.
export const LEADERBOARD_WEIGHTS = { tests: 30, projects: 25, capstone: 15, interview: 15, attendance: 15 };

export const leaderboard = async (tenant, programId) => {
  const { rows: reg } = await tenantQuery(
    tenant,
    `SELECT to_regclass('interview_slots') IS NOT NULL AS has_iv,
            to_regclass('capstone_submissions') IS NOT NULL AS has_cap`,
    [],
  );
  const hasIv = !!reg[0]?.has_iv;
  const hasCap = !!reg[0]?.has_cap;

  // Achievable maxes for the program (the denominators for normalization).
  const ivMaxJoin = hasIv
    ? `LEFT JOIN (SELECT COALESCE(sum(max_marks),0) AS mx FROM mock_interviews WHERE program_id=$1 AND deleted_at IS NULL) ivm ON true`
    : '';
  const capSel = hasCap ? 'COALESCE(cap.m,0)' : '0';
  const capMaxJoin = hasCap
    ? `LEFT JOIN (SELECT COALESCE(sum(max_marks),0) AS mx FROM capstone_projects WHERE program_id=$1 AND deleted_at IS NULL) capm ON true`
    : '';
  const capEarnedJoin = hasCap
    ? `LEFT JOIN (SELECT cs.student_id, sum(cs.marks) AS m FROM capstone_submissions cs JOIN capstone_projects cp ON cp.id=cs.capstone_id WHERE cp.program_id=$1 AND cs.marks IS NOT NULL GROUP BY cs.student_id) cap ON cap.student_id = s.id`
    : '';
  // Interview earned = finalized slots only.
  const ivEarnedJoin = hasIv
    ? `LEFT JOIN (SELECT sl.student_id, sum(sl.marks) AS m FROM interview_slots sl JOIN mock_interviews i ON i.id=sl.interview_id WHERE i.program_id=$1 AND i.deleted_at IS NULL AND sl.deleted_at IS NULL AND sl.graded_at IS NOT NULL AND sl.marks IS NOT NULL GROUP BY sl.student_id) iv ON iv.student_id = s.id`
    : '';
  const ivEarnedSel = hasIv ? 'COALESCE(iv.m,0)' : '0';
  const ivMaxSel = hasIv ? 'COALESCE(ivm.mx,0)' : '0';
  const capMaxSel = hasCap ? 'COALESCE(capm.mx,0)' : '0';

  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id AS student_id, s.name,
            COALESCE(tt.m,0)::numeric AS test_marks,
            COALESCE(pr.m,0)::numeric AS project_marks,
            ${capSel}::numeric AS capstone_marks,
            ${ivEarnedSel}::numeric AS interview_marks,
            COALESCE(tm.mx,0)::numeric AS test_max,
            COALESCE(pm.mx,0)::numeric AS project_max,
            ${capMaxSel}::numeric AS capstone_max,
            ${ivMaxSel}::numeric AS interview_max,
            COALESCE(att.total,0)::int AS att_total,
            COALESCE(att.present,0)::int AS att_present
       FROM students s
       LEFT JOIN (SELECT a.student_id, sum(a.score) AS m FROM mock_test_attempts a JOIN mock_tests t ON t.id=a.test_id WHERE t.program_id=$1 AND t.deleted_at IS NULL GROUP BY a.student_id) tt ON tt.student_id = s.id
       LEFT JOIN (SELECT COALESCE(sum(total_marks),0) AS mx FROM mock_tests WHERE program_id=$1 AND deleted_at IS NULL AND is_published) tm ON true
       LEFT JOIN (SELECT ps.student_id, sum(ps.marks) AS m FROM project_submissions ps JOIN projects p ON p.id=ps.project_id WHERE p.program_id=$1 AND ps.marks IS NOT NULL GROUP BY ps.student_id) pr ON pr.student_id = s.id
       LEFT JOIN (SELECT COALESCE(sum(max_marks),0) AS mx FROM projects WHERE program_id=$1 AND deleted_at IS NULL) pm ON true
       ${capEarnedJoin}
       ${capMaxJoin}
       ${ivEarnedJoin}
       ${ivMaxJoin}
       LEFT JOIN (
         SELECT bs.student_id,
                count(*) FILTER (WHERE c.ended_at IS NOT NULL)::int AS total,
                count(*) FILTER (WHERE att.status='present' AND c.ended_at IS NOT NULL)::int AS present
           FROM batch_students bs
           JOIN classes c ON c.batch_id = bs.batch_id AND c.deleted_at IS NULL AND c.program_id = $1
           LEFT JOIN attendance att ON att.class_id = c.id AND att.student_id = bs.student_id
          WHERE bs.deleted_at IS NULL
          GROUP BY bs.student_id
       ) att ON att.student_id = s.id
      WHERE s.program_id = $1 AND s.deleted_at IS NULL`,
    [programId],
  );

  const W = LEADERBOARD_WEIGHTS;
  const pct = (earned, max) => (max > 0 ? Math.min(100, (Number(earned) / Number(max)) * 100) : null);
  const scored = rows.map((r) => {
    const subs = {
      tests: pct(r.test_marks, r.test_max),
      projects: pct(r.project_marks, r.project_max),
      capstone: pct(r.capstone_marks, r.capstone_max),
      interview: pct(r.interview_marks, r.interview_max),
      attendance: Number(r.att_total) > 0 ? (Number(r.att_present) / Number(r.att_total)) * 100 : null,
    };
    // Renormalize weights across only the components that exist for this program.
    let wsum = 0; let acc = 0;
    for (const k of Object.keys(W)) { if (subs[k] != null) { wsum += W[k]; acc += W[k] * subs[k]; } }
    const total = wsum > 0 ? acc / wsum : 0;
    const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
    return {
      student_id: r.student_id,
      name: r.name,
      // 0–100 subscores (null = component not present in this program).
      test_score: round1(subs.tests),
      project_score: round1(subs.projects),
      capstone_score: round1(subs.capstone),
      interview_score: round1(subs.interview),
      attendance_pct: round1(subs.attendance),
      total: round1(total),
    };
  });
  scored.sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
  return scored;
};
