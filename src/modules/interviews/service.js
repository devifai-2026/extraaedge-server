// Mock interviews — trainer creates one (manual meeting link), assigns students
// to date/time slots, and records per-student marks (which feed the
// leaderboard). Students see their own slots + marks.
import * as repo from './repo.js';
import * as coursesRepo from '../courses/repo.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notifyStudent } from '../../lib/socket.js';

const isAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;
const assertProgramTrainer = async (tenant, programId, actor) => {
  if (isAdmin(actor)) return;
  const m = await coursesRepo.isCourseTrainer(tenant, programId, actor?.id);
  if (!m) throw forbidden('You are not assigned to this course.');
};

export const create = async (tenant, actor, input) => {
  await assertProgramTrainer(tenant, input.program_id, actor);
  return repo.create(tenant, input, actor?.id);
};
export const list = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.list(tenant, programId);
};
export const programStudents = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.programStudents(tenant, programId);
};
export const listSlots = async (tenant, actor, interviewId) => {
  const iv = await repo.get(tenant, interviewId);
  if (!iv) throw notFound('Interview not found');
  await assertProgramTrainer(tenant, iv.program_id, actor);
  return repo.listSlots(tenant, interviewId);
};
export const assignSlot = async (tenant, actor, interviewId, studentId, slotAt) => {
  const iv = await repo.get(tenant, interviewId);
  if (!iv) throw notFound('Interview not found');
  await assertProgramTrainer(tenant, iv.program_id, actor);
  const slot = await repo.assignSlot(tenant, interviewId, studentId, slotAt);
  notifyStudent(tenant.id, studentId, 'lms.interview_assigned', { interview_id: interviewId, slot_at: slotAt });
  return slot;
};
export const gradeSlot = async (tenant, actor, slotId, marks, feedback) => {
  const slot = await repo.slotById(tenant, slotId);
  if (!slot) throw notFound('Slot not found');
  await assertProgramTrainer(tenant, slot.program_id, actor);
  if (marks == null || Number(marks) < 0) throw validationError({ marks: 'Enter valid marks' });
  const row = await repo.gradeSlot(tenant, slotId, marks, feedback, actor?.id);
  if (row) notifyStudent(tenant.id, row.student_id, 'lms.interview_graded', { slot_id: slotId, marks });
  return row;
};

// ---------- Student ----------
export const studentSlots = async (tenant, studentId) => repo.studentSlots(tenant, studentId);
