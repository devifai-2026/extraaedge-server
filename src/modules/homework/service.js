// Homework — lightweight per-class/module assignments with a file submission,
// distinct from portfolio `projects`/`capstone`. Trainer/head/admin (+
// branch_manager) create + grade; students submit a file + notes. Scope reuses
// course_trainers membership (admins/branch_managers bypass).
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

const signFiles = async (rows) => Promise.all(rows.map(async (r) => ({
  ...r,
  file_url: r.file_r2_key ? await getDownloadSignedUrl({ key: r.file_r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS }).catch(() => null) : null,
})));

export const list = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.list(tenant, programId);
};

export const create = async (tenant, actor, input) => {
  await assertProgramTrainer(tenant, input.program_id, actor);
  if (!input.title || !String(input.title).trim()) throw validationError({ title: 'Title is required' });
  const row = await repo.create(tenant, input, actor?.id);
  notifyBatch(tenant, { programId: input.program_id }, {
    type: 'homework_assigned', message: `New homework: ${input.title}`, link: '/student/homework', metadata: { assignment_id: row?.id },
  });
  return row;
};

export const remove = async (tenant, actor, id) => {
  const a = await repo.getById(tenant, id);
  if (!a) throw notFound('Assignment not found');
  await assertProgramTrainer(tenant, a.program_id, actor);
  await repo.softDelete(tenant, id);
  return { ok: true };
};

export const listSubmissions = async (tenant, actor, assignmentId) => {
  const a = await repo.getById(tenant, assignmentId);
  if (!a) throw notFound('Assignment not found');
  await assertProgramTrainer(tenant, a.program_id, actor);
  return signFiles(await repo.listSubmissions(tenant, assignmentId));
};

export const grade = async (tenant, actor, submissionId, marks, feedback) => {
  const sub = await repo.submissionById(tenant, submissionId);
  if (!sub) throw notFound('Submission not found');
  await assertProgramTrainer(tenant, sub.program_id, actor);
  const m = Number(marks);
  if (Number.isNaN(m) || m < 0) throw validationError({ marks: 'Enter valid marks' });
  if (m > Number(sub.max_marks)) throw validationError({ marks: `Max is ${sub.max_marks}` });
  const row = await repo.grade(tenant, submissionId, m, feedback, actor?.id);
  if (row) pushStudentNotification(tenant, row.student_id, { type: 'homework_graded', message: `Your homework was graded: ${m}/${sub.max_marks}.`, link: '/student/homework', metadata: { submission_id: submissionId } });
  return row;
};

// ---------- Student ----------
export const studentAssignments = async (tenant, studentId) => signFiles(await repo.studentAssignments(tenant, studentId));

export const submit = async (tenant, studentId, assignmentId, input) => {
  const programId = await repo.studentProgram(tenant, studentId);
  const a = await repo.getById(tenant, assignmentId);
  if (!a || a.program_id !== programId) throw notFound('Homework not in your course.');
  if (!input.file_r2_key && !input.notes) throw validationError({ submission: 'Attach a file or add notes.' });
  return repo.submit(tenant, assignmentId, studentId, input);
};
