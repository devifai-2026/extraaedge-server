// Mock interviews — trainer creates one (manual meeting link) with a per-interview
// rubric of categories (Coding /30, Communication /20…), each scored by 'trainer'
// or 'hr'. Trainer assigns students to slots + an HR evaluator; trainer scores the
// technical categories, HR scores the soft-skill ones. Each category mark is capped
// at its own max; the slot total (interview_slots.marks) is the roll-up the
// leaderboard reads. Students see their per-category breakdown + total.
import * as repo from './repo.js';
import * as coursesRepo from '../courses/repo.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import { pushStudentNotification } from '../student-notifications/service.js';

const isAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;
const assertProgramTrainer = async (tenant, programId, actor) => {
  if (isAdmin(actor)) return;
  const m = await coursesRepo.isCourseTrainer(tenant, programId, actor?.id);
  if (!m) throw forbidden('You are not assigned to this course.');
};

export const create = async (tenant, actor, input) => {
  await assertProgramTrainer(tenant, input.program_id, actor);
  const categories = Array.isArray(input.categories) ? input.categories.filter((c) => c && c.name) : [];
  // With a rubric, the interview max = sum of category maxes.
  const maxMarks = categories.length ? categories.reduce((a, c) => a + (Number(c.max_marks) || 0), 0) : (input.max_marks ?? 100);
  const iv = await repo.create(tenant, { ...input, max_marks: maxMarks }, actor?.id);
  if (categories.length) await repo.addCategories(tenant, iv.id, categories);
  return iv;
};

export const list = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.list(tenant, programId);
};
export const programStudents = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.programStudents(tenant, programId);
};
export const assignableHr = async (tenant, actor) => {
  if (!isAdmin(actor) && actor?.role !== LMS_TENANT_ROLES.HEAD_TRAINER && actor?.role !== LMS_TENANT_ROLES.TRAINER) return [];
  return repo.assignableHr(tenant);
};

// A slot with its per-category scores attached, plus completeness flags:
// `complete` = every rubric category scored (or flat-graded); `pending_hr` =
// an HR soft-skill category still needs a score. A slot is only final when
// complete (see recomputeSlotTotal / the leaderboard).
const decorateSlot = (slot, scores, categories) => {
  const scoredIds = new Set(scores.map((sc) => String(sc.category_id)));
  const total = categories.length;
  const pendingCats = categories.filter((c) => !scoredIds.has(String(c.id)));
  const complete = total > 0 ? pendingCats.length === 0 : !!slot.graded_at;
  const pending_hr = pendingCats.some((c) => c.scored_by === 'hr');
  const pending_trainer = pendingCats.some((c) => c.scored_by === 'trainer');
  return { ...slot, scores, complete, pending_hr, pending_trainer };
};
const withScores = async (tenant, slots, categories = null) => Promise.all(slots.map(async (s) => {
  const cats = categories ?? [];
  return decorateSlot(s, await repo.slotScores(tenant, s.id), cats);
}));

export const listSlots = async (tenant, actor, interviewId) => {
  const iv = await repo.get(tenant, interviewId);
  if (!iv) throw notFound('Interview not found');
  await assertProgramTrainer(tenant, iv.program_id, actor);
  const [slots, categories] = await Promise.all([repo.listSlots(tenant, interviewId), repo.listCategories(tenant, interviewId)]);
  return { interview: { id: iv.id, title: iv.title, max_marks: iv.max_marks, hr_user_id: iv.hr_user_id, hr_user_name: iv.hr_user_name }, categories, slots: await withScores(tenant, slots, categories) };
};

export const assignSlot = async (tenant, actor, interviewId, studentId, slotAt) => {
  const iv = await repo.get(tenant, interviewId);
  if (!iv) throw notFound('Interview not found');
  await assertProgramTrainer(tenant, iv.program_id, actor);
  const slot = await repo.assignSlot(tenant, interviewId, studentId, slotAt);
  pushStudentNotification(tenant, studentId, { type: 'interview_assigned', message: `You've been assigned a mock interview: "${iv.title}".`, link: '/student/interviews', metadata: { interview_id: interviewId, slot_at: slotAt } });
  return slot;
};

export const assignHr = async (tenant, actor, interviewId, hrUserId) => {
  const iv = await repo.get(tenant, interviewId);
  if (!iv) throw notFound('Interview not found');
  await assertProgramTrainer(tenant, iv.program_id, actor);
  return repo.setHrEvaluator(tenant, interviewId, hrUserId);
};

// Flat grade (interviews with no rubric). Kept for back-compat.
export const gradeSlot = async (tenant, actor, slotId, marks, feedback) => {
  const slot = await repo.slotById(tenant, slotId);
  if (!slot) throw notFound('Slot not found');
  await assertProgramTrainer(tenant, slot.program_id, actor);
  if (marks == null || Number(marks) < 0) throw validationError({ marks: 'Enter valid marks' });
  const row = await repo.gradeSlot(tenant, slotId, marks, feedback, actor?.id);
  if (row) pushStudentNotification(tenant, row.student_id, { type: 'interview_graded', message: `Your mock interview was graded: ${marks} marks.`, link: '/student/interviews', metadata: { slot_id: slotId, marks } });
  return row;
};

// Per-category scoring. Each score: { category_id, marks }. Validates the mark
// against the category max and that the caller may score that category
// (trainer categories → course trainer/admin; hr categories → assigned HR / admin).
export const scoreSlot = async (tenant, actor, slotId, scores) => {
  const slot = await repo.slotById(tenant, slotId);
  if (!slot) throw notFound('Slot not found');
  if (!Array.isArray(scores) || !scores.length) throw validationError({ scores: 'No scores provided' });
  for (const sc of scores) {
    // eslint-disable-next-line no-await-in-loop
    const cat = await repo.categoryById(tenant, sc.category_id);
    if (!cat || cat.interview_id !== slot.interview_id) throw validationError({ scores: 'Invalid category for this interview' });
    const marks = Number(sc.marks);
    if (Number.isNaN(marks) || marks < 0) throw validationError({ marks: `Enter valid marks for ${cat.name}` });
    if (marks > Number(cat.max_marks)) throw validationError({ marks: `${cat.name}: max is ${cat.max_marks}` });
    if (cat.scored_by === 'hr') {
      const allowed = isAdmin(actor) || (cat.hr_user_id && cat.hr_user_id === actor?.id);
      if (!allowed) throw forbidden(`Only the assigned HR can score "${cat.name}".`);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await assertProgramTrainer(tenant, cat.program_id, actor);
    }
    // eslint-disable-next-line no-await-in-loop
    await repo.upsertSlotScore(tenant, slotId, sc.category_id, marks, actor?.id);
  }
  const row = await repo.recomputeSlotTotal(tenant, slotId, actor?.id);
  if (row) pushStudentNotification(tenant, row.student_id, { type: 'interview_graded', message: `Your mock interview was scored: ${row.marks} marks.`, link: '/student/interviews', metadata: { slot_id: slotId } });
  return row;
};

// ---------- HR queue (interviews the HR user evaluates) ----------
export const hrQueue = async (tenant, actor) => {
  const interviews = await repo.listForHr(tenant, actor?.id);
  return Promise.all(interviews.map(async (iv) => {
    const [slots, categories] = await Promise.all([repo.listSlots(tenant, iv.id), repo.listCategories(tenant, iv.id)]);
    return { ...iv, categories, slots: await withScores(tenant, slots, categories) };
  }));
};

// ---------- Student ----------
export const studentSlots = async (tenant, studentId) => {
  const slots = await repo.studentSlots(tenant, studentId);
  // Categories vary per interview — fetch each interview's rubric once.
  const byInterview = new Map();
  await Promise.all([...new Set(slots.map((s) => s.interview_id))].map(async (iid) => {
    byInterview.set(String(iid), await repo.listCategories(tenant, iid));
  }));
  return Promise.all(slots.map(async (s) =>
    decorateSlot(s, await repo.slotScores(tenant, s.id), byInterview.get(String(s.interview_id)) ?? [])));
};
