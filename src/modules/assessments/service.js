// Assessments — mock tests (auto-scored MCQ), projects (live+github submit +
// grading), and the derived leaderboard.
import * as repo from './repo.js';
import * as coursesRepo from '../courses/repo.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { pushStudentNotification } from '../student-notifications/service.js';

const isAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;
const assertProgramTrainer = async (tenant, programId, actor) => {
  if (isAdmin(actor)) return;
  const m = await coursesRepo.isCourseTrainer(tenant, programId, actor?.id);
  if (!m) throw forbidden('You are not assigned to this course.');
};

// ---------- Tests (trainer) ----------
export const createTest = async (tenant, actor, input) => {
  await assertProgramTrainer(tenant, input.program_id, actor);
  if (!Array.isArray(input.questions) || input.questions.length === 0) throw validationError({ questions: 'Add at least one question' });
  return repo.createTest(tenant, input, actor?.id);
};
export const listTests = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.listTests(tenant, programId);
};
export const testResults = async (tenant, actor, testId) => {
  const t = await repo.getTest(tenant, testId);
  if (!t) throw notFound('Test not found');
  await assertProgramTrainer(tenant, t.program_id, actor);
  return repo.testResults(tenant, testId);
};

// Edit a test. Attempts are one-shot and auto-scored, so once ANY student has
// attempted it, changing the questions (which changes scoring) is blocked —
// title/module-only edits are still allowed. Fixing a wrong correct_index is
// therefore possible right up until the first attempt.
export const updateTest = async (tenant, actor, testId, patch) => {
  const t = await repo.getTest(tenant, testId);
  if (!t) throw notFound('Test not found');
  await assertProgramTrainer(tenant, t.program_id, actor);
  if (Array.isArray(patch.questions)) {
    if (!patch.questions.length) throw validationError({ questions: 'Add at least one question' });
    const attempts = await repo.attemptCountForTest(tenant, testId);
    if (attempts > 0) throw validationError({ questions: `Can't change questions — ${attempts} student(s) already attempted. Unpublish + clone to re-test.` });
  }
  return repo.updateTest(tenant, testId, patch);
};

export const setTestPublished = async (tenant, actor, testId, published) => {
  const t = await repo.getTest(tenant, testId);
  if (!t) throw notFound('Test not found');
  await assertProgramTrainer(tenant, t.program_id, actor);
  return repo.setPublished(tenant, testId, published);
};

export const deleteTest = async (tenant, actor, testId) => {
  const t = await repo.getTest(tenant, testId);
  if (!t) throw notFound('Test not found');
  await assertProgramTrainer(tenant, t.program_id, actor);
  await repo.softDeleteTest(tenant, testId);
  return { ok: true };
};

// ---------- Tests (student) ----------
export const studentTests = async (tenant, studentId) => repo.studentTests(tenant, studentId);

export const takeTest = async (tenant, studentId, testId) => {
  const t = await repo.studentTakeTest(tenant, testId, studentId);
  if (!t) throw notFound('Test not available');
  const existing = await repo.studentAttempt(tenant, testId, studentId);
  return { ...t, already_attempted: !!existing, my_score: existing?.score ?? null };
};

// Auto-score against correct_index, one attempt only.
export const submitTest = async (tenant, studentId, testId, answers) => {
  const test = await repo.getTest(tenant, testId);
  if (!test || !test.is_published) throw notFound('Test not available');
  const questions = test.questions || [];
  let score = 0;
  questions.forEach((q, i) => {
    if (q.correct_index != null && Number(answers?.[i]) === Number(q.correct_index)) score += Number(q.marks) || 0;
  });
  const saved = await repo.recordAttempt(tenant, testId, studentId, answers ?? [], score);
  if (!saved) throw validationError({ test: 'You have already attempted this test.' });
  return { score, total_marks: Number(test.total_marks) };
};

// ---------- Projects (trainer) ----------
export const createProject = async (tenant, actor, input) => {
  await assertProgramTrainer(tenant, input.program_id, actor);
  return repo.createProject(tenant, input, actor?.id);
};
export const listProjects = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.listProjects(tenant, programId);
};
export const listSubmissions = async (tenant, actor, projectId) => {
  const p = await repo.getProject(tenant, projectId);
  if (!p) throw notFound('Project not found');
  await assertProgramTrainer(tenant, p.program_id, actor);
  return repo.listSubmissions(tenant, projectId);
};
export const gradeSubmission = async (tenant, actor, projectId, submissionId, marks, feedback) => {
  const p = await repo.getProject(tenant, projectId);
  if (!p) throw notFound('Project not found');
  await assertProgramTrainer(tenant, p.program_id, actor);
  if (marks == null || Number(marks) < 0 || Number(marks) > Number(p.max_marks)) throw validationError({ marks: `0..${p.max_marks}` });
  const row = await repo.gradeSubmission(tenant, submissionId, marks, feedback, actor?.id);
  if (row) pushStudentNotification(tenant, row.student_id, { type: 'project_graded', message: `Your project "${p.title}" was graded: ${marks}/${p.max_marks}.`, link: '/student/projects', metadata: { project_id: projectId, marks } });
  return row;
};

// ---------- Projects (student) ----------
export const studentProjects = async (tenant, studentId) => repo.studentProjects(tenant, studentId);

export const submitProject = async (tenant, studentId, projectId, input) => {
  const p = await repo.getProject(tenant, projectId);
  if (!p) throw notFound('Project not found');
  const sp = await repo.studentProgram(tenant, studentId);
  if (p.program_id !== sp) throw forbidden('Not your course');
  if (p.deadline && new Date() > new Date(p.deadline)) throw validationError({ deadline: 'The deadline has passed.' });
  if (!input.live_url && !input.github_url) throw validationError({ url: 'Provide a live URL or a GitHub URL.' });
  return repo.submitProject(tenant, projectId, studentId, input);
};

// ---------- Leaderboard ----------
export const leaderboard = async (tenant, programId) => repo.leaderboard(tenant, programId);

export const trainerLeaderboard = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.leaderboard(tenant, programId);
};

export const studentLeaderboard = async (tenant, studentId) => {
  const programId = await repo.studentProgram(tenant, studentId);
  if (!programId) return [];
  return repo.leaderboard(tenant, programId);
};
