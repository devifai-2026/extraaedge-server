import * as service from './service.js';

const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

// ---- Student ----
export const trainers = async (req, res, next) => {
  try { ok(res, req, await service.trainersForStudent(req.tenant, req.student.id)); } catch (e) { next(e); }
};
export const createThread = async (req, res, next) => {
  try { ok(res, req, await service.createThread(req.tenant, req.student.id, req.body), 201); } catch (e) { next(e); }
};
export const myThreads = async (req, res, next) => {
  try { ok(res, req, await service.listMyThreads(req.tenant, req.student.id)); } catch (e) { next(e); }
};
export const studentReplies = async (req, res, next) => {
  try { ok(res, req, await service.studentRepliesFor(req.tenant, req.student.id, req.params.id)); } catch (e) { next(e); }
};
export const studentReply = async (req, res, next) => {
  try { ok(res, req, await service.replyAsStudent(req.tenant, req.student.id, req.params.id, req.body.body), 201); } catch (e) { next(e); }
};

// ---- Trainer ----
export const listThreads = async (req, res, next) => {
  try { ok(res, req, await service.listThreads(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); }
};
export const trainerReplies = async (req, res, next) => {
  try { ok(res, req, await service.repliesFor(req.tenant, req.params.id)); } catch (e) { next(e); }
};
export const trainerReply = async (req, res, next) => {
  try { ok(res, req, await service.replyAsTrainer(req.tenant, req.user, req.params.id, req.body.body), 201); } catch (e) { next(e); }
};
