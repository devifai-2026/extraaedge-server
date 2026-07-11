// Recordings + announcements.
//
// - Trainers attach a class recording (r2_key from a prior presign→PUT with
//   purpose 'recording'); attaching auto-posts an announcement to the class's
//   batch and pushes a socket event. Students stream via a signed URL, gated by
//   their batch recordings_from cutoff.
// - Announcements: trainers post to a course/batch; students + trainers comment
//   and like.
import * as repo from './repo.js';
import * as classesRepo from '../classes/repo.js';
import * as coursesRepo from '../courses/repo.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';
import { emitToBatch } from '../../lib/socket.js';
import { notifyBatch } from '../student-notifications/service.js';
import { env } from '../../config/env.js';

const isAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;

const assertClassTrainer = async (tenant, classId, actor) => {
  const c = await classesRepo.classBatchId(tenant, classId);
  if (!c) throw notFound('Class not found');
  if (!isAdmin(actor)) {
    const m = await coursesRepo.isCourseTrainer(tenant, c.program_id, actor?.id);
    if (!m) throw forbidden('You are not assigned to this course.');
  }
  return c;
};

const assertProgramTrainer = async (tenant, programId, actor) => {
  if (isAdmin(actor)) return;
  const m = await coursesRepo.isCourseTrainer(tenant, programId, actor?.id);
  if (!m) throw forbidden('You are not assigned to this course.');
};

// ---------- Recordings (trainer) ----------
export const addRecording = async (tenant, actor, classId, input) => {
  const c = await assertClassTrainer(tenant, classId, actor);
  const rec = await repo.addRecording(tenant, classId, input, actor?.id);
  const cls = await classesRepo.getClass(tenant, classId);
  // Auto-post an announcement to the batch so students are notified.
  await repo.createAnnouncement(tenant, {
    program_id: c.program_id, batch_id: c.batch_id, class_id: classId,
    title: `Recording available: ${cls?.title || 'class'}`,
    body: `The recording for "${cls?.title || 'the class'}" has been uploaded. Watch it from your Recordings tab.`,
    auto_source: 'recording',
  }, actor?.id);
  emitToBatch(tenant.id, c.batch_id, 'lms:announcement', { program_id: c.program_id, class_id: classId, kind: 'recording' });
  notifyBatch(tenant, { programId: c.program_id, batchId: c.batch_id }, {
    type: 'announcement', message: `New recording: "${cls?.title || 'class'}".`, link: '/student/recordings',
  });
  return rec;
};

export const listRecordings = async (tenant, actor, classId) => {
  await assertClassTrainer(tenant, classId, actor);
  return repo.listRecordings(tenant, classId);
};

export const missedRecordings = async (tenant, actor) =>
  repo.classesMissingRecording(tenant, actor?.id, isAdmin(actor));

// Signed URL for a trainer (no student gating — they own the course).
export const trainerRecordingUrl = async (tenant, actor, recordingId) => {
  const rec = await repo.getRecording(tenant, recordingId);
  if (!rec) throw notFound('Recording not found');
  await assertClassTrainer(tenant, rec.class_id, actor);
  return getDownloadSignedUrl({ key: rec.r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS });
};

// ---------- Announcements (trainer) ----------
export const postAnnouncement = async (tenant, actor, input) => {
  await assertProgramTrainer(tenant, input.program_id, actor);
  const a = await repo.createAnnouncement(tenant, input, actor?.id);
  emitToBatch(tenant.id, input.batch_id, 'lms:announcement', { program_id: input.program_id });
  notifyBatch(tenant, { programId: input.program_id, batchId: input.batch_id }, {
    type: 'announcement', message: input.title ? `Announcement: ${input.title}` : 'New announcement from your trainer.', link: '/student/announcements',
  });
  return a;
};

export const listAnnouncements = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.listAnnouncements(tenant, { programId }, { kind: 'user', id: actor?.id });
};

export const listComments = async (tenant, announcementId) => repo.listComments(tenant, announcementId);

export const commentAsTrainer = async (tenant, actor, announcementId, body) => {
  const a = await repo.getAnnouncement(tenant, announcementId);
  if (!a) throw notFound('Announcement not found');
  await assertProgramTrainer(tenant, a.program_id, actor);
  return repo.addComment(tenant, announcementId, { kind: 'user', id: actor?.id }, body);
};

export const likeAsTrainer = async (tenant, actor, announcementId) => {
  const a = await repo.getAnnouncement(tenant, announcementId);
  if (!a) throw notFound('Announcement not found');
  await assertProgramTrainer(tenant, a.program_id, actor);
  return repo.toggleLike(tenant, announcementId, { kind: 'user', id: actor?.id });
};

// ---------- Student-facing ----------
export const studentRecordings = async (tenant, studentId) => repo.studentRecordings(tenant, studentId);

export const studentRecordingUrl = async (tenant, studentId, recordingId) => {
  const may = await repo.studentMayViewRecording(tenant, recordingId, studentId);
  if (!may) throw forbidden('This recording is not available to you.');
  const rec = await repo.getRecording(tenant, recordingId);
  return getDownloadSignedUrl({ key: rec.r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS });
};

export const studentAnnouncements = async (tenant, studentId) => {
  const sp = await repo.studentProgram(tenant, studentId);
  if (!sp?.program_id) return [];
  return repo.listAnnouncements(tenant, { programId: sp.program_id, batchId: sp.batch_id }, { kind: 'student', id: studentId });
};

export const studentComment = async (tenant, studentId, announcementId, body) => {
  const can = await repo.studentCanSeeAnnouncement(tenant, announcementId, studentId);
  if (!can) throw forbidden('Not your course');
  return repo.addComment(tenant, announcementId, { kind: 'student', id: studentId }, body);
};

export const studentLike = async (tenant, studentId, announcementId) => {
  const can = await repo.studentCanSeeAnnouncement(tenant, announcementId, studentId);
  if (!can) throw forbidden('Not your course');
  return repo.toggleLike(tenant, announcementId, { kind: 'student', id: studentId });
};

export const commentsFor = async (tenant, announcementId) => repo.listComments(tenant, announcementId);

export { validationError };
