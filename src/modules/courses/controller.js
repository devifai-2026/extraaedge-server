import * as service from './service.js';

const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

// ---- Courses ----
export const listCourses = async (req, res, next) => {
  try { ok(res, req, await service.listCourses(req.tenant, req.user)); } catch (e) { next(e); }
};
export const getCourse = async (req, res, next) => {
  try { ok(res, req, await service.getCourse(req.tenant, req.user, req.params.programId)); } catch (e) { next(e); }
};

// ---- Modules ----
export const listModules = async (req, res, next) => {
  try { ok(res, req, await service.listModules(req.tenant, req.user, req.params.programId)); } catch (e) { next(e); }
};
export const createModule = async (req, res, next) => {
  try { ok(res, req, await service.createModule(req.tenant, req.user, req.params.programId, req.body), 201); } catch (e) { next(e); }
};
export const updateModule = async (req, res, next) => {
  try { ok(res, req, await service.updateModule(req.tenant, req.user, req.params.programId, req.params.moduleId, req.body)); } catch (e) { next(e); }
};
export const deleteModule = async (req, res, next) => {
  try { await service.deleteModule(req.tenant, req.user, req.params.programId, req.params.moduleId); res.status(204).end(); } catch (e) { next(e); }
};

// ---- Trainers ----
export const listTrainers = async (req, res, next) => {
  try { ok(res, req, await service.listTrainers(req.tenant, req.user, req.params.programId)); } catch (e) { next(e); }
};
export const addTrainer = async (req, res, next) => {
  try { ok(res, req, await service.addTrainer(req.tenant, req.user, req.params.programId, req.body), 201); } catch (e) { next(e); }
};
export const removeTrainer = async (req, res, next) => {
  try { await service.removeTrainer(req.tenant, req.user, req.params.programId, req.params.id); res.status(204).end(); } catch (e) { next(e); }
};

// ---- Batches ----
export const listBatches = async (req, res, next) => {
  try { ok(res, req, await service.listBatches(req.tenant, req.user, req.params.programId)); } catch (e) { next(e); }
};
export const createBatch = async (req, res, next) => {
  try { ok(res, req, await service.createBatch(req.tenant, req.user, req.params.programId, req.body), 201); } catch (e) { next(e); }
};
export const listBatchStudents = async (req, res, next) => {
  try { ok(res, req, await service.listBatchStudents(req.tenant, req.user, req.params.programId, req.params.batchId)); } catch (e) { next(e); }
};
export const listUnassignedStudents = async (req, res, next) => {
  try { ok(res, req, await service.listUnassignedStudents(req.tenant, req.user, req.params.programId)); } catch (e) { next(e); }
};
export const placeStudent = async (req, res, next) => {
  try { ok(res, req, await service.placeStudent(req.tenant, req.user, req.params.programId, req.body), 201); } catch (e) { next(e); }
};
export const mergeBatches = async (req, res, next) => {
  try { ok(res, req, await service.mergeBatches(req.tenant, req.user, req.params.programId, req.body)); } catch (e) { next(e); }
};

// ---- Student self-view ----
export const myCourse = async (req, res, next) => {
  try { ok(res, req, await service.myCourse(req.tenant, req.student.id)); } catch (e) { next(e); }
};
