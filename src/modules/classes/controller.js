import * as service from './service.js';

const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

// ---- Trainer: classes ----
export const listClasses = async (req, res, next) => {
  try { ok(res, req, await service.listClasses(req.tenant, req.user, { programId: req.query.programId, batchId: req.query.batchId })); } catch (e) { next(e); }
};
export const createClass = async (req, res, next) => {
  try { ok(res, req, await service.createClass(req.tenant, req.user, req.body), 201); } catch (e) { next(e); }
};
export const updateClass = async (req, res, next) => {
  try { ok(res, req, await service.updateClass(req.tenant, req.user, req.params.id, req.body)); } catch (e) { next(e); }
};
export const deleteClass = async (req, res, next) => {
  try { await service.deleteClass(req.tenant, req.user, req.params.id); res.status(204).end(); } catch (e) { next(e); }
};
export const markLifecycle = async (req, res, next) => {
  try { ok(res, req, await service.markLifecycle(req.tenant, req.user, req.params.id, req.body.action)); } catch (e) { next(e); }
};

// ---- Trainer: question bank ----
export const listBank = async (req, res, next) => {
  try { ok(res, req, await service.listBank(req.tenant, req.user, req.query.programId, req.params.moduleId)); } catch (e) { next(e); }
};
export const addBankQuestion = async (req, res, next) => {
  try { ok(res, req, await service.addBankQuestion(req.tenant, req.user, req.query.programId, req.params.moduleId, req.body), 201); } catch (e) { next(e); }
};
export const deleteBankQuestion = async (req, res, next) => {
  try { await service.deleteBankQuestion(req.tenant, req.user, req.query.programId, req.params.id); res.status(204).end(); } catch (e) { next(e); }
};

// ---- Trainer: fire question + attendance ----
export const fireQuestion = async (req, res, next) => {
  try { ok(res, req, await service.fireQuestion(req.tenant, req.user, req.params.id, req.body), 201); } catch (e) { next(e); }
};
export const listQuestions = async (req, res, next) => {
  try { ok(res, req, await service.listQuestions(req.tenant, req.user, req.params.id)); } catch (e) { next(e); }
};
export const attendanceTable = async (req, res, next) => {
  try { ok(res, req, await service.attendanceTable(req.tenant, req.user, req.params.id)); } catch (e) { next(e); }
};
export const editAttendance = async (req, res, next) => {
  try { ok(res, req, await service.editAttendance(req.tenant, req.user, req.params.id, req.body.student_id, req.body.status)); } catch (e) { next(e); }
};

// ---- Student ----
export const studentClasses = async (req, res, next) => {
  try { ok(res, req, await service.studentClasses(req.tenant, req.student.id)); } catch (e) { next(e); }
};
export const openQuestions = async (req, res, next) => {
  try { ok(res, req, await service.openQuestions(req.tenant, req.student.id, req.params.id)); } catch (e) { next(e); }
};
export const answer = async (req, res, next) => {
  try { ok(res, req, await service.answer(req.tenant, req.student.id, req.params.id, req.body.question_id, req.body.option_index), 201); } catch (e) { next(e); }
};
export const preNotifyAbsence = async (req, res, next) => {
  try { ok(res, req, await service.preNotifyAbsence(req.tenant, req.student.id, req.params.id, req.body?.reason ?? null)); } catch (e) { next(e); }
};
export const setJoinMode = async (req, res, next) => {
  try { ok(res, req, await service.setJoinMode(req.tenant, req.student.id, req.params.id, req.body.join_mode, req.body?.reason ?? null)); } catch (e) { next(e); }
};
