// Classes + live-MCQ attendance.
//
// Scope reuses the course-membership rule (a trainer/head may act on a class
// only if they're on that course's roster; admins bypass). Live pieces use the
// socket: firing a question broadcasts to the batch room; a student's answer
// recomputes attendance and pushes the updated table to the room.
import * as repo from './repo.js';
import * as coursesRepo from '../courses/repo.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { emitToBatch } from '../../lib/socket.js';

const isSuperAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN
  || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;

const assertCourseTrainer = async (tenant, programId, actor) => {
  if (isSuperAdmin(actor)) return;
  const m = await coursesRepo.isCourseTrainer(tenant, programId, actor?.id);
  if (!m) throw forbidden('You are not assigned to this course.');
};

const assertClassAccess = async (tenant, classId, actor) => {
  const c = await repo.classBatchId(tenant, classId);
  if (!c) throw notFound('Class not found');
  await assertCourseTrainer(tenant, c.program_id, actor);
  return c;
};

// ---------- Classes (trainer) ----------
export const listClasses = async (tenant, actor, query) => {
  if (query.programId) await assertCourseTrainer(tenant, query.programId, actor);
  return repo.listClasses(tenant, query);
};

export const createClass = async (tenant, actor, input) => {
  await assertCourseTrainer(tenant, input.program_id, actor);
  if (new Date(input.ends_at) <= new Date(input.starts_at)) throw validationError({ ends_at: 'End must be after start' });
  return repo.createClass(tenant, input, actor?.id);
};

export const updateClass = async (tenant, actor, id, input) => {
  await assertClassAccess(tenant, id, actor);
  const row = await repo.updateClass(tenant, id, input);
  if (!row) throw notFound('Class not found');
  return row;
};

export const deleteClass = async (tenant, actor, id) => {
  await assertClassAccess(tenant, id, actor);
  await repo.deleteClass(tenant, id);
};

// Trainer lifecycle = their own attendance. Broadcasts a class-state event.
export const markLifecycle = async (tenant, actor, id, action) => {
  const c = await assertClassAccess(tenant, id, actor);
  const row = await repo.markLifecycle(tenant, id, action, actor?.id);
  emitToBatch(tenant.id, c.batch_id, 'lms:class-state', { class_id: id, action });
  return row;
};

// ---------- Question bank ----------
export const listBank = async (tenant, actor, programId, moduleId) => {
  await assertCourseTrainer(tenant, programId, actor);
  return repo.listBank(tenant, moduleId);
};
export const addBankQuestion = async (tenant, actor, programId, moduleId, input) => {
  await assertCourseTrainer(tenant, programId, actor);
  return repo.addBankQuestion(tenant, moduleId, input, actor?.id);
};
export const deleteBankQuestion = async (tenant, actor, programId, id) => {
  await assertCourseTrainer(tenant, programId, actor);
  await repo.deleteBankQuestion(tenant, id);
};

// ---------- Fire question (live) ----------
export const fireQuestion = async (tenant, actor, classId, input) => {
  const c = await assertClassAccess(tenant, classId, actor);
  const q = await repo.fireQuestion(tenant, classId, input, actor?.id);
  // Push to the batch room WITHOUT the correct answer.
  emitToBatch(tenant.id, c.batch_id, 'lms:attendance-question', {
    class_id: classId,
    question: { id: q.id, question: q.question, options: q.options, closes_at: q.closes_at, visible_minutes: q.visible_minutes },
  });
  return q;
};

export const listQuestions = async (tenant, actor, classId) => {
  await assertClassAccess(tenant, classId, actor);
  return repo.listQuestions(tenant, classId);
};

// ---------- Attendance (trainer) ----------
export const attendanceTable = async (tenant, actor, classId) => {
  await assertClassAccess(tenant, classId, actor);
  await repo.recomputeAttendance(tenant, classId);
  return repo.attendanceTable(tenant, classId);
};

export const editAttendance = async (tenant, actor, classId, studentId, status) => {
  await assertClassAccess(tenant, classId, actor);
  if (!['present', 'absent'].includes(status)) throw validationError({ status: 'present|absent' });
  return repo.editAttendance(tenant, classId, studentId, status, actor?.id);
};

// ---------- Student-facing ----------
export const studentClasses = async (tenant, studentId) => repo.studentClasses(tenant, studentId);

export const openQuestions = async (tenant, studentId, classId) => {
  const inBatch = await repo.studentInClassBatch(tenant, classId, studentId);
  if (!inBatch) throw forbidden('Not your class');
  return repo.openQuestionsForStudent(tenant, classId, studentId);
};

// Student answers → record (if window open), recompute, push updated state.
export const answer = async (tenant, studentId, classId, questionId, optionIndex) => {
  const inBatch = await repo.studentInClassBatch(tenant, classId, studentId);
  if (!inBatch) throw forbidden('Not your class');
  const saved = await repo.answerQuestion(tenant, questionId, studentId, optionIndex);
  if (!saved) throw validationError({ question: 'This question has closed or was already answered.' });
  await repo.recomputeAttendance(tenant, classId);
  const c = await repo.classBatchId(tenant, classId);
  // Nudge the trainer console to refresh its live table.
  if (c) emitToBatch(tenant.id, c.batch_id, 'lms:attendance-updated', { class_id: classId });
  return { ok: true };
};

export const preNotifyAbsence = async (tenant, studentId, classId, reason = null) => {
  const inBatch = await repo.studentInClassBatch(tenant, classId, studentId);
  if (!inBatch) throw forbidden('Not your class');
  return repo.preNotifyAbsence(tenant, classId, studentId, reason);
};

export const setJoinMode = async (tenant, studentId, classId, joinMode, reason = null) => {
  const inBatch = await repo.studentInClassBatch(tenant, classId, studentId);
  if (!inBatch) throw forbidden('Not your class');
  if (!['online', 'offline'].includes(joinMode)) throw validationError({ join_mode: 'online|offline' });
  await repo.setJoinMode(tenant, classId, studentId, joinMode, reason);
  return { ok: true };
};
