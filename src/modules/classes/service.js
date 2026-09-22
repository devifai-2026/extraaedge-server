// Classes + live-MCQ attendance.
//
// Scope reuses the course-membership rule (a trainer/head may act on a class
// only if they're on that course's roster; admins bypass). Live pieces use the
// socket: firing a question broadcasts to the batch room; a student's answer
// recomputes attendance and pushes the updated table to the room.
import * as repo from './repo.js';
import * as coursesRepo from '../courses/repo.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, ADMIN_TIER_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import { emitToBatch } from '../../lib/socket.js';
import { notifyBatch } from '../student-notifications/service.js';
import { logger } from '../../lib/logger.js';

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
  const row = await repo.createClass(tenant, input, actor?.id);
  // Notify the batch's students that a class is on the calendar.
  notifyBatch(tenant, { batchId: input.batch_id }, {
    type: 'class_scheduled', message: `New class scheduled: ${input.title}`, link: '/student/classes', metadata: { class_id: row?.id },
  });
  return row;
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

  // Tell the batch the class is open. The socket event above only reaches
  // students with the portal already loaded; the notification is what shows up
  // on the dashboard for everyone else.
  if (action === 'class_started') {
    notifyBatch(tenant, { batchId: c.batch_id }, {
      type: 'class_started',
      message: 'Your class has started — join now',
      link: '/student/classes',
      metadata: { class_id: id },
    });
  }
  return row;
};

// Who may overrule a completion verdict: the branch manager and above, plus the
// head trainer who owns the roster. A trainer may set their OWN class while it
// is still pending, but cannot reverse a decision once it is made — otherwise
// the 24-hour deadline means nothing.
const OVERRIDE_ROLES = [...ADMIN_TIER_ROLES, LMS_TENANT_ROLES.HEAD_TRAINER];

export const setCompletion = async (tenant, actor, id, { status, note, is_billable }) => {
  // assertClassAccess only returns program_id/batch_id, so read the full row —
  // the guards below turn on completion_status, and an undefined field would
  // silently let anyone reverse a decided class.
  const access = await assertClassAccess(tenant, id, actor);
  const c = { ...access, ...(await repo.findClass(tenant, id)) };
  if (!c?.id) throw notFound('Class not found');
  const canOverride = OVERRIDE_ROLES.includes(actor.role);

  // Already decided — only an override role may change it.
  if (c.completion_status && c.completion_status !== 'pending' && !canOverride) {
    throw forbidden(
      c.auto_marked_at
        ? 'This class was already closed by the system. Ask your branch manager to change it.'
        : 'This class has already been marked. Ask your branch manager to change it.',
    );
  }

  // Marking a class billable is a pay decision, so it is not the trainer's to
  // make unilaterally — they mark it complete, a manager marks it payable.
  if (is_billable !== undefined && !canOverride) {
    throw forbidden('Only a manager can mark a class as billable');
  }

  const isOverride = canOverride && c.completion_status !== 'pending';
  const row = await repo.setCompletion(tenant, id, {
    status, note, billable: is_billable, actorId: actor.id, isOverride,
  });
  if (!row) throw notFound('Class not found');

  emitToBatch(tenant.id, c.batch_id, 'lms:class-state', {
    class_id: id, action: status === 'completed' ? 'class_ended' : 'class_not_conducted',
  });

  // Completing the LAST class of a module completes the module, which is what
  // the trainer performance report measures on-time delivery against. Failure
  // here must not fail the class completion the trainer just made.
  if (status === 'completed' && c.module_id) {
    try {
      await coursesRepo.autoCompleteModuleIfDone(tenant, c.module_id);
    } catch (err) {
      logger.warn({ tenantId: tenant.id, moduleId: c.module_id, err: err.message },
        'module auto-completion failed');
    }
  }
  return row;
};

// Classes this trainer started and forgot to end. Managers see everyone's,
// since an unended class blocks the module completion they are measured on.
export const unendedClasses = async (tenant, actor) => {
  const isManager = OVERRIDE_ROLES.includes(actor.role);
  return repo.unendedClassesFor(tenant, { trainerId: isManager ? null : actor.id });
};

// The trainer's own worklist: what still needs confirming, and by when.
export const pendingCompletions = async (tenant, actor) => {
  const isManager = OVERRIDE_ROLES.includes(actor.role);
  return repo.pendingCompletionsFor(tenant, {
    trainerId: isManager ? null : actor.id,
  });
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

// ---------- Question kinds ----------
// true_false is an MCQ with a fixed option list, so it reuses the whole
// option_index machinery instead of needing a branch of its own. The labels are
// seeded HERE rather than trusted from the client, so index 0 is always True.
export const QUESTION_TYPES = ['mcq', 'true_false', 'long_text'];
export const TRUE_FALSE_OPTIONS = ['True', 'False'];

// Normalise a trainer-supplied question into the shape the table expects, and
// reject the combinations that would silently produce an ungradable question.
export const normaliseQuestionInput = (input) => {
  const type = input.question_type ?? 'mcq';
  if (!QUESTION_TYPES.includes(type)) {
    throw validationError({ question_type: `must be one of ${QUESTION_TYPES.join('|')}` });
  }
  if (type === 'long_text') {
    // No options, and nothing to auto-grade against: the trainer marks these
    // by hand afterwards.
    return { ...input, question_type: type, options: [], correct_index: null };
  }
  const options = type === 'true_false'
    ? TRUE_FALSE_OPTIONS
    : (input.options ?? []).map((o) => String(o).trim()).filter(Boolean);
  if (options.length < 2) throw validationError({ options: 'at least 2 options' });

  const ci = input.correct_index;
  if (ci !== null && ci !== undefined) {
    if (!Number.isInteger(ci) || ci < 0 || ci >= options.length) {
      throw validationError({ correct_index: 'must point at one of the options' });
    }
  }
  return { ...input, question_type: type, options, correct_index: ci ?? null };
};

// A class that has ended is closed for business: no new questions, no answers,
// no joining. Enforced HERE rather than only in the UI — hiding a button stops
// an honest mistake, not a replayed request, and attendance is what payroll and
// the performance report are computed from.
const assertClassLive = (c, what) => {
  if (c?.ended_at) throw validationError({ class: `This class has ended — ${what} is closed.` });
  if (!c?.started_at) throw validationError({ class: `This class has not started yet — ${what} is not open.` });
};

// ---------- Fire question (live) ----------
export const fireQuestion = async (tenant, actor, classId, input) => {
  const c = await assertClassAccess(tenant, classId, actor);
  assertClassLive(c, 'firing questions');
  const q = await repo.fireQuestion(tenant, classId, normaliseQuestionInput(input), actor?.id);
  // Push to the batch room WITHOUT the correct answer — students receive the
  // question and its options only. correct_index never leaves the server here,
  // or the answer would be readable in the browser's socket frames.
  emitToBatch(tenant.id, c.batch_id, 'lms:attendance-question', {
    class_id: classId,
    question: {
      id: q.id, question: q.question, question_type: q.question_type,
      options: q.options, closes_at: q.closes_at, visible_minutes: q.visible_minutes,
    },
  });
  // Also drop a persistent notification so students who aren't looking get nudged.
  notifyBatch(tenant, { batchId: c.batch_id }, {
    type: 'attendance_question', message: 'Live attendance question — answer now to be marked present', link: '/student/classes', metadata: { class_id: classId },
  });
  return q;
};

export const listQuestions = async (tenant, actor, classId) => {
  await assertClassAccess(tenant, classId, actor);
  return repo.listQuestions(tenant, classId);
};

// Per-question results for the trainer: who answered what, and who got it
// right, by name. Trainer-only — this is the one place correct_index and the
// students' answers are exposed together.
export const questionAnalytics = async (tenant, actor, classId) => {
  await assertClassAccess(tenant, classId, actor);
  const questions = await repo.questionAnalytics(tenant, classId);
  return questions.map((q) => {
    const answers = q.answers ?? [];
    const tally = { correct: 0, wrong: 0, ungraded: 0 };
    for (const a of answers) tally[a.verdict] = (tally[a.verdict] ?? 0) + 1;
    return {
      ...q,
      answers,
      no_answer: q.no_answer ?? [],
      summary: {
        answered: answers.length,
        no_answer: (q.no_answer ?? []).length,
        ...tally,
      },
    };
  });
};

// Trainer marks a single long_text answer right or wrong. Choice questions are
// settled by correct_index and are rejected in the repo, so a trainer cannot
// contradict the auto-grade.
export const gradeAnswer = async (tenant, actor, classId, answerId, isCorrect) => {
  await assertClassAccess(tenant, classId, actor);
  const saved = await repo.gradeAnswer(tenant, answerId, isCorrect, actor?.id);
  if (!saved) throw validationError({ answer_id: 'Not a gradable (long text) answer.' });
  return saved;
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
export const answer = async (tenant, studentId, classId, questionId, optionIndex, answerText = null) => {
  const inBatch = await repo.studentInClassBatch(tenant, classId, studentId);
  if (!inBatch) throw forbidden('Not your class');

  // A pending question dies with the class. Without this a student could
  // answer inside the question's own window after the trainer had ended the
  // class, and be marked present for a class they were absent from.
  const cls = await repo.classBatchId(tenant, classId);
  assertClassLive(cls, 'answering');

  // The payload has to match the question's kind: a long_text answer carries
  // text and no option, every other kind carries an option and no text.
  const q = await repo.questionById(tenant, questionId);
  if (!q || q.class_id !== classId) throw validationError({ question: 'Unknown question for this class.' });
  let idx = optionIndex;
  let text = null;
  if (q.question_type === 'long_text') {
    text = String(answerText ?? '').trim();
    if (!text) throw validationError({ answer_text: 'Answer cannot be empty.' });
    idx = repo.LONG_TEXT_NO_OPTION;
  } else {
    const opts = Array.isArray(q.options) ? q.options : [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= opts.length) {
      throw validationError({ option_index: 'must point at one of the options' });
    }
  }

  const saved = await repo.answerQuestion(tenant, questionId, studentId, idx, text);
  if (!saved) throw validationError({ question: 'This question has closed or was already answered.' });
  await repo.recomputeAttendance(tenant, classId);
  const c = await repo.classBatchId(tenant, classId);
  // Nudge the trainer console to refresh its live table.
  if (c) emitToBatch(tenant.id, c.batch_id, 'lms:attendance-updated', { class_id: classId });
  return { ok: true };
};

// Student clicks through to the class. Only possible between the trainer
// starting and ending it — which is what makes the portal button dynamic:
// "Not started" -> "Join Class" -> "Rejoin" -> "Class ended".
export const joinClass = async (tenant, studentId, classId) => {
  const inBatch = await repo.studentInClassBatch(tenant, classId, studentId);
  if (!inBatch) throw forbidden('Not your class');
  const cls = await repo.classBatchId(tenant, classId);
  assertClassLive(cls, 'joining');
  const saved = await repo.recordJoin(tenant, classId, studentId);
  // The trainer's live table shows who has actually turned up.
  emitToBatch(tenant.id, cls.batch_id, 'lms:attendance-updated', { class_id: classId });
  return { ...saved, meeting_url: cls.meeting_url };
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
