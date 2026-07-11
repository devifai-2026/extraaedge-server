// Capstone — course-level project. Trainer/head/admin (branch_manager included)
// create + grade; students submit a live URL + GitHub + optional file. Scope
// reuses course_trainers membership (admins/branch_managers bypass).
import * as repo from './repo.js';
import * as coursesRepo from '../courses/repo.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';
import { env } from '../../config/env.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { pushStudentNotification, notifyBatch } from '../student-notifications/service.js';

const isAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;
const assertProgramTrainer = async (tenant, programId, actor) => {
  if (isAdmin(actor)) return;
  const m = await coursesRepo.isCourseTrainer(tenant, programId, actor?.id);
  if (!m) throw forbidden('You are not assigned to this course.');
};

export const list = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.list(tenant, programId);
};

export const create = async (tenant, actor, input) => {
  await assertProgramTrainer(tenant, input.program_id, actor);
  const row = await repo.create(tenant, input, actor?.id);
  notifyBatch(tenant, { programId: input.program_id }, {
    type: 'capstone_assigned', message: `New capstone project: ${input.title}`, link: '/student/capstone', metadata: { capstone_id: row?.id },
  });
  return row;
};

export const remove = async (tenant, actor, id) => {
  const c = await repo.get(tenant, id);
  if (!c) throw notFound('Capstone not found');
  await assertProgramTrainer(tenant, c.program_id, actor);
  await repo.softDelete(tenant, id);
  return { ok: true };
};

const signFiles = async (rows) => Promise.all(rows.map(async (r) => ({
  ...r,
  file_url: r.file_r2_key ? await getDownloadSignedUrl({ key: r.file_r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS }).catch(() => null) : null,
})));

export const listSubmissions = async (tenant, actor, capstoneId) => {
  const c = await repo.get(tenant, capstoneId);
  if (!c) throw notFound('Capstone not found');
  await assertProgramTrainer(tenant, c.program_id, actor);
  return signFiles(await repo.listSubmissions(tenant, capstoneId));
};

export const grade = async (tenant, actor, submissionId, marks, feedback) => {
  const sub = await repo.submissionById(tenant, submissionId);
  if (!sub) throw notFound('Submission not found');
  await assertProgramTrainer(tenant, sub.program_id, actor);
  const m = Number(marks);
  if (Number.isNaN(m) || m < 0) throw validationError({ marks: 'Enter valid marks' });
  if (m > Number(sub.max_marks)) throw validationError({ marks: `Max is ${sub.max_marks}` });
  const row = await repo.grade(tenant, submissionId, m, feedback, actor?.id);
  if (row) pushStudentNotification(tenant, row.student_id, { type: 'capstone_graded', message: `Your capstone was graded: ${m}/${sub.max_marks}.`, link: '/student/capstone', metadata: { submission_id: submissionId } });
  return row;
};

// ---------- Student ----------
export const studentCapstones = async (tenant, studentId) => {
  const programId = await repo.studentProgram(tenant, studentId);
  if (!programId) return [];
  return signFiles(await repo.studentCapstones(tenant, studentId, programId));
};

export const submit = async (tenant, studentId, capstoneId, input) => {
  const programId = await repo.studentProgram(tenant, studentId);
  const c = await repo.get(tenant, capstoneId);
  if (!c || c.program_id !== programId) throw notFound('Capstone not in your course.');
  if (!input.live_url && !input.github_url && !input.file_r2_key) throw validationError({ submission: 'Provide a live URL, GitHub link, or file.' });
  return repo.submit(tenant, capstoneId, studentId, input);
};
