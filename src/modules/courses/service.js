// Courses / modules / trainers / batches.
//
// Access model:
//   - super_admin: full write on any course (creates courses, names heads).
//   - head_trainer: manages modules/trainers/batches of courses they HEAD.
//   - trainer: read-only on courses they're on the roster of.
// Scope is enforced here via course_trainers membership (the trainer-scope
// key), mirroring the admissions guided_by_counsellor_id pattern.
import * as repo from './repo.js';
import * as usersService from '../users/service.js';
import * as usersRepo from '../users/repo.js';
import * as studentAuthService from '../student-auth/service.js';
import * as studentAuthRepo from '../student-auth/repo.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';
import { env } from '../../config/env.js';
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

// The pool of teaching users a head/admin can add to a roster. No course scope
// needed (it's the tenant's trainer pool), but still staff-gated by the router.
export const assignableStaff = async (tenant) => repo.assignableStaff(tenant);

// Per-student attendance history for a course (any roster trainer or admin).
export const attendanceHistory = async (tenant, actor, programId) => {
  await assertCanRead(tenant, programId, actor);
  return repo.attendanceHistory(tenant, programId);
};

// Trainer-dashboard insights: totals + a student roster (avatars) across the
// courses the actor teaches (admins see all).
export const trainerInsights = async (tenant, actor) => {
  const courses = await repo.listCourses(tenant, { trainerId: isSuperAdmin(actor) ? undefined : actor?.id });
  const programIds = courses.map((c) => c.id);
  const zero = { courses: courses.length, modules: 0, batches: 0, students: 0, active_students: 0 };
  if (!programIds.length) return { totals: zero, students: [] };
  const [counts, roster, perCourse] = await Promise.all([
    repo.countStudentsForPrograms(tenant, programIds),
    repo.studentsForPrograms(tenant, programIds, 24),
    repo.perCourseStats(tenant, programIds),
  ]);
  const students = await Promise.all(roster.map(async (s) => ({
    id: s.id, name: s.name, status: s.status, batch_name: s.batch_name, program_name: s.program_name,
    photo_url: s.photo_r2_key ? await getDownloadSignedUrl({ key: s.photo_r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS }).catch(() => null) : null,
  })));
  const totals = {
    courses: courses.length,
    modules: courses.reduce((a, c) => a + (Number(c.module_count) || 0), 0),
    batches: courses.reduce((a, c) => a + (Number(c.batch_count) || 0), 0),
    students: counts.total || 0,
    active_students: counts.active || 0,
    on_break: counts.on_break || 0,
    dropped: counts.dropped || 0,
    pending: counts.pending || 0,
    unassigned: counts.unassigned || 0,
  };
  return { totals, students, per_course: perCourse, courses: courses.map((c) => ({ id: c.id, name: c.name })) };
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
  // Accept a single student_id (legacy) or a student_ids[] (multi-select).
  const ids = (input.student_ids && input.student_ids.length) ? input.student_ids : (input.student_id ? [input.student_id] : []);
  if (!ids.length) throw validationError({ student_id: 'Select at least one student' });
  for (const sid of ids) {
    // eslint-disable-next-line no-await-in-loop
    await repo.placeStudentInBatch(tenant, { batchId: input.batch_id, studentId: sid, shareRecordings: !!input.share_recordings }, actor?.id);
  }
  return { placed: ids.length };
};

// Head/admin creates a NEW teaching user (trainer or head) and binds them to
// this course in one step — so a head trainer can onboard trainers without the
// full admin Users screen. Role is whitelisted to teaching roles only.
export const createTrainer = async (tenant, actor, programId, input) => {
  await assertCanManage(tenant, programId, actor);
  const role = input.role === 'head' ? LMS_TENANT_ROLES.HEAD_TRAINER : LMS_TENANT_ROLES.TRAINER;
  let branchId = null;
  if (actor?.id) { const a = await usersRepo.findById(tenant, actor.id); branchId = a?.branch_id || null; }
  if (!branchId) branchId = await repo.firstBranchId(tenant);
  const user = await usersService.createUser(tenant, {
    name: input.name, email: input.email, password: input.password, role, branch_id: branchId,
  }, actor);
  const binding = await repo.addTrainer(tenant, programId, { user_id: user.id, role: input.role === 'head' ? 'head' : 'trainer', module_id: input.module_id ?? null }, actor?.id);
  return { user, binding };
};

// Mark a batch completed (batch lifecycle: active → completed). status already
// supports it; we stamp end_date if unset.
export const completeBatch = async (tenant, actor, programId, batchId) => {
  await assertCanManage(tenant, programId, actor);
  const batch = await repo.getBatch(tenant, batchId);
  if (!batch || batch.program_id !== programId) throw notFound('Batch not in this course');
  return repo.setBatchCompleted(tenant, batchId);
};

// ---------- Students management (admin + head trainer, course-scoped) ----------
const actorProgramIds = async (tenant, actor) => {
  const courses = await repo.listCourses(tenant, { trainerId: isSuperAdmin(actor) ? undefined : actor?.id });
  return courses.map((c) => c.id);
};

export const listCourseStudents = async (tenant, actor) => {
  const ids = await actorProgramIds(tenant, actor);
  return repo.courseStudents(tenant, ids);
};

// A student is in the actor's scope if the actor is a super_admin, or heads/is
// on the roster of the student's course.
const assertStudentInScope = async (tenant, actor, studentId) => {
  const student = await studentAuthRepo.findById(tenant, studentId);
  if (!student) throw notFound('Student not found');
  if (isSuperAdmin(actor)) return student;
  const membership = student.program_id ? await repo.isCourseTrainer(tenant, student.program_id, actor?.id) : null;
  if (!membership) throw forbidden('This student is not in one of your courses.');
  return student;
};

export const resetStudentPassword = async (tenant, actor, studentId) => {
  await assertStudentInScope(tenant, actor, studentId);
  const password = studentAuthService.generateTempPassword();
  await studentAuthService.setInitialPassword(tenant, studentId, password);
  return { password };
};

export const sudoStudent = async (tenant, actor, studentId) => {
  await assertStudentInScope(tenant, actor, studentId);
  return studentAuthService.sudoLoginAsStudent(tenant, studentId);
};

export const mergeBatches = async (tenant, actor, programId, input) => {
  // Any trainer on the course roster (head OR trainer), or an admin, may merge
  // batches — not just the head. (assertCanRead = super_admin or roster member.)
  await assertCanRead(tenant, programId, actor);
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

export const dashboard = async (tenant, studentId) => {
  const view = await repo.studentDashboard(tenant, studentId);
  if (!view) throw notFound('No enrolment found');
  // Tenant branding for the student sidebar (logo + name). tenant here is the
  // resolved row, which carries logo_url/brand_name/name + accent.
  view.tenant = {
    name: tenant.company_name || tenant.brand_name || tenant.name,
    logo_url: tenant.logo_url || null,
    brand_primary_color: tenant.brand_primary_color || '#E53935',
  };
  return view;
};

export { LMS_TENANT_ROLES };
