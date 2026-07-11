// Student doubt forum.
//
// A student opens a thread scoped to their course, optionally @mentioning
// trainers (by user id). Mentioned trainers — or, if none, all course trainers
// — get a persisted bell notification (pushNotification) + socket push.
// Trainers on the course reply; a trainer reply flips the thread to 'answered'
// and notifies the student.
import * as repo from './repo.js';
import * as coursesRepo from '../courses/repo.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { pushNotification } from '../notifications/service.js';
import { pushStudentNotification } from '../student-notifications/service.js';

const isAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;

const assertProgramTrainer = async (tenant, programId, actor) => {
  if (isAdmin(actor)) return;
  const m = await coursesRepo.isCourseTrainer(tenant, programId, actor?.id);
  if (!m) throw forbidden('You are not assigned to this course.');
};

// ---------- Student ----------
export const trainersForStudent = async (tenant, studentId) => {
  const programId = await repo.studentProgram(tenant, studentId);
  if (!programId) return [];
  return repo.courseTrainers(tenant, programId);
};

export const createThread = async (tenant, studentId, input) => {
  const programId = await repo.studentProgram(tenant, studentId);
  if (!programId) throw validationError({ course: 'You are not enrolled in a course yet.' });
  const allTrainers = await repo.courseTrainerUserIds(tenant, programId);
  // Only allow mentioning trainers who actually teach this course.
  const mentions = (input.mentions || []).filter((id) => allTrainers.includes(id));
  const thread = await repo.createThread(tenant, { program_id: programId, student_id: studentId, title: input.title, body: input.body, mentions });

  // Notify mentioned trainers (or all course trainers if none mentioned).
  const targets = mentions.length ? mentions : allTrainers;
  for (const uid of targets) {
    try {
      await pushNotification(tenant, {
        user_id: uid, type: 'lms.forum_mention',
        message: `New doubt in the student forum: "${input.title}"`,
        link: '/trainer/forum',
        metadata_json: { thread_id: thread.id, program_id: programId },
      });
    } catch { /* never block on a notify */ }
  }
  return thread;
};

export const listMyThreads = async (tenant, studentId) => {
  const programId = await repo.studentProgram(tenant, studentId);
  if (!programId) return [];
  return repo.listThreads(tenant, programId);
};

export const replyAsStudent = async (tenant, studentId, threadId, body) => {
  const thread = await repo.getThread(tenant, threadId);
  if (!thread) throw notFound('Thread not found');
  const programId = await repo.studentProgram(tenant, studentId);
  if (thread.program_id !== programId) throw forbidden('Not your course');
  return repo.addReply(tenant, threadId, { kind: 'student', id: studentId }, body);
};

// ---------- Trainer ----------
export const listThreads = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.listThreads(tenant, programId);
};

export const listReplies = async (tenant, threadId) => repo.listReplies(tenant, threadId);

export const replyAsTrainer = async (tenant, actor, threadId, body) => {
  const thread = await repo.getThread(tenant, threadId);
  if (!thread) throw notFound('Thread not found');
  await assertProgramTrainer(tenant, thread.program_id, actor);
  const reply = await repo.addReply(tenant, threadId, { kind: 'user', id: actor?.id }, body);
  // Notify the student their doubt was answered.
  pushStudentNotification(tenant, thread.student_id, {
    type: 'forum_answered', message: `A trainer answered: "${thread.title}".`,
    link: '/student/forum', metadata: { thread_id: threadId },
  });
  return reply;
};

export const repliesFor = async (tenant, threadId) => repo.listReplies(tenant, threadId);
