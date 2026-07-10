// Courses / modules / trainers / batches.
//
// Access model:
//   - super_admin: full write on any course (creates courses, names heads).
//   - head_trainer: manages modules/trainers/batches of courses they HEAD.
//   - trainer: read-only on courses they're on the roster of.
// Scope is enforced here via course_trainers membership (the trainer-scope
// key), mirroring the admissions guided_by_counsellor_id pattern.
import * as repo from './repo.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';

const isSuperAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN;

// Throw unless the actor may READ this course (super_admin, or on the roster).
const assertCanRead = async (tenant, programId, actor) => {
  if (isSuperAdmin(actor)) return;
  const membership = await repo.isCourseTrainer(tenant, programId, actor?.id);
  if (!membership) throw forbidden('You are not assigned to this course.');
  return membership;
};

// Throw unless the actor may MANAGE this course (super_admin or its head_trainer).
const assertCanManage = async (tenant, programId, actor) => {
  if (isSuperAdmin(actor)) return;
  const membership = await repo.isCourseTrainer(tenant, programId, actor?.id);
  if (!membership || membership.role !== 'head') {
    throw forbidden('Only the course head trainer (or an admin) can do this.');
  }
};

// ---------- Courses ----------
export const listCourses = async (tenant, actor) => {
  // Admins see all; trainers see only their own.
  const trainerId = isSuperAdmin(actor) ? undefined : actor?.id;
  return repo.listCourses(tenant, { trainerId });
};

export const getCourse = async (tenant, actor, programId) => {
  await assertCanRead(tenant, programId, actor);
  const course = await repo.getCourse(tenant, programId);
  if (!course) throw notFound('Course not found');
  return course;
};

// ---------- Modules ----------
export const listModules = async (tenant, actor, programId) => {
  await assertCanRead(tenant, programId, actor);
  return repo.listModules(tenant, programId);
};

export const createModule = async (tenant, actor, programId, input) => {
  await assertCanManage(tenant, programId, actor);
  return repo.createModule(tenant, programId, input, actor?.id);
};

export const updateModule = async (tenant, actor, programId, moduleId, input) => {
  await assertCanManage(tenant, programId, actor);
  const row = await repo.updateModule(tenant, moduleId, input);
  if (!row) throw notFound('Module not found');
  return row;
};

export const deleteModule = async (tenant, actor, programId, moduleId) => {
  await assertCanManage(tenant, programId, actor);
  await repo.deleteModule(tenant, moduleId);
};

// ---------- Trainers (roster) ----------
export const listTrainers = async (tenant, actor, programId) => {
  await assertCanRead(tenant, programId, actor);
  return repo.listTrainers(tenant, programId);
};

// Adding a HEAD is admin-only; the head then adds module trainers.
export const addTrainer = async (tenant, actor, programId, input) => {
  if (input.role === 'head') {
    if (!isSuperAdmin(actor)) throw forbidden('Only an admin can assign the course head trainer.');
  } else {
    await assertCanManage(tenant, programId, actor);
  }
  return repo.addTrainer(tenant, programId, input, actor?.id);
};

export const removeTrainer = async (tenant, actor, programId, id) => {
  await assertCanManage(tenant, programId, actor);
  await repo.removeTrainer(tenant, id);
};

// ---------- Batches (head_trainer / admin only) ----------
export const listBatches = async (tenant, actor, programId) => {
  await assertCanRead(tenant, programId, actor);
  return repo.listBatches(tenant, programId);
};

export const createBatch = async (tenant, actor, programId, input) => {
  await assertCanManage(tenant, programId, actor);
  return repo.createBatch(tenant, programId, input, actor?.id);
};

export const listBatchStudents = async (tenant, actor, programId, batchId) => {
  await assertCanRead(tenant, programId, actor);
  return repo.listBatchStudents(tenant, batchId);
};

export const listUnassignedStudents = async (tenant, actor, programId) => {
  await assertCanRead(tenant, programId, actor);
  return repo.listUnassignedStudents(tenant, programId);
};

export const placeStudent = async (tenant, actor, programId, input) => {
  await assertCanManage(tenant, programId, actor);
  const batch = await repo.getBatch(tenant, input.batch_id);
  if (!batch || batch.program_id !== programId) throw validationError({ batch_id: 'Batch not in this course' });
  return repo.placeStudentInBatch(tenant, {
    batchId: input.batch_id, studentId: input.student_id, shareRecordings: !!input.share_recordings,
  }, actor?.id);
};

export const mergeBatches = async (tenant, actor, programId, input) => {
  await assertCanManage(tenant, programId, actor);
  if (input.source_batch_id === input.target_batch_id) throw validationError({ target_batch_id: 'Pick a different target batch' });
  const [src, tgt] = await Promise.all([repo.getBatch(tenant, input.source_batch_id), repo.getBatch(tenant, input.target_batch_id)]);
  if (!src || src.program_id !== programId) throw validationError({ source_batch_id: 'Source batch not in this course' });
  if (!tgt || tgt.program_id !== programId) throw validationError({ target_batch_id: 'Target batch not in this course' });
  return repo.mergeBatches(tenant, {
    sourceBatchId: input.source_batch_id, targetBatchId: input.target_batch_id, shareRecordings: !!input.share_recordings,
  }, actor?.id);
};

// ---------- Student self-view ----------
export const myCourse = async (tenant, studentId) => {
  const view = await repo.studentCourseView(tenant, studentId);
  if (!view) throw notFound('No enrolment found');
  return view;
};

export { LMS_TENANT_ROLES };
