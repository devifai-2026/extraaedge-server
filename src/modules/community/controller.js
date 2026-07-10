import * as service from './service.js';

const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

// ---- Trainer: recordings ----
export const addRecording = async (req, res, next) => {
  try { ok(res, req, await service.addRecording(req.tenant, req.user, req.params.classId, req.body), 201); } catch (e) { next(e); }
};
export const listRecordings = async (req, res, next) => {
  try { ok(res, req, await service.listRecordings(req.tenant, req.user, req.params.classId)); } catch (e) { next(e); }
};
export const missedRecordings = async (req, res, next) => {
  try { ok(res, req, await service.missedRecordings(req.tenant, req.user)); } catch (e) { next(e); }
};
export const trainerRecordingUrl = async (req, res, next) => {
  try { ok(res, req, { url: await service.trainerRecordingUrl(req.tenant, req.user, req.params.id) }); } catch (e) { next(e); }
};

// ---- Trainer: announcements ----
export const postAnnouncement = async (req, res, next) => {
  try { ok(res, req, await service.postAnnouncement(req.tenant, req.user, req.body), 201); } catch (e) { next(e); }
};
export const listAnnouncements = async (req, res, next) => {
  try { ok(res, req, await service.listAnnouncements(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); }
};
export const listComments = async (req, res, next) => {
  try { ok(res, req, await service.commentsFor(req.tenant, req.params.id)); } catch (e) { next(e); }
};
export const commentAsTrainer = async (req, res, next) => {
  try { ok(res, req, await service.commentAsTrainer(req.tenant, req.user, req.params.id, req.body.body), 201); } catch (e) { next(e); }
};
export const likeAsTrainer = async (req, res, next) => {
  try { ok(res, req, await service.likeAsTrainer(req.tenant, req.user, req.params.id)); } catch (e) { next(e); }
};

// ---- Student ----
export const studentRecordings = async (req, res, next) => {
  try { ok(res, req, await service.studentRecordings(req.tenant, req.student.id)); } catch (e) { next(e); }
};
export const studentRecordingUrl = async (req, res, next) => {
  try { ok(res, req, { url: await service.studentRecordingUrl(req.tenant, req.student.id, req.params.id) }); } catch (e) { next(e); }
};
export const studentAnnouncements = async (req, res, next) => {
  try { ok(res, req, await service.studentAnnouncements(req.tenant, req.student.id)); } catch (e) { next(e); }
};
export const studentComments = async (req, res, next) => {
  try { ok(res, req, await service.commentsFor(req.tenant, req.params.id)); } catch (e) { next(e); }
};
export const studentComment = async (req, res, next) => {
  try { ok(res, req, await service.studentComment(req.tenant, req.student.id, req.params.id, req.body.body), 201); } catch (e) { next(e); }
};
export const studentLike = async (req, res, next) => {
  try { ok(res, req, await service.studentLike(req.tenant, req.student.id, req.params.id)); } catch (e) { next(e); }
};
