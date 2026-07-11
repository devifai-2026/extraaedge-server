import * as service from './service.js';

const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

// ---- Trainer: tests ----
export const createTest = async (req, res, next) => { try { ok(res, req, await service.createTest(req.tenant, req.user, req.body), 201); } catch (e) { next(e); } };
export const listTests = async (req, res, next) => { try { ok(res, req, await service.listTests(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); } };
export const testResults = async (req, res, next) => { try { ok(res, req, await service.testResults(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const updateTest = async (req, res, next) => { try { ok(res, req, await service.updateTest(req.tenant, req.user, req.params.id, req.body)); } catch (e) { next(e); } };
export const setTestPublished = async (req, res, next) => { try { ok(res, req, await service.setTestPublished(req.tenant, req.user, req.params.id, req.body.published)); } catch (e) { next(e); } };
export const deleteTest = async (req, res, next) => { try { ok(res, req, await service.deleteTest(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };

// ---- Trainer: projects ----
export const createProject = async (req, res, next) => { try { ok(res, req, await service.createProject(req.tenant, req.user, req.body), 201); } catch (e) { next(e); } };
export const listProjects = async (req, res, next) => { try { ok(res, req, await service.listProjects(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); } };
export const listSubmissions = async (req, res, next) => { try { ok(res, req, await service.listSubmissions(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const gradeSubmission = async (req, res, next) => { try { ok(res, req, await service.gradeSubmission(req.tenant, req.user, req.params.id, req.body.submission_id, req.body.marks, req.body.feedback)); } catch (e) { next(e); } };

// ---- Trainer: leaderboard ----
export const trainerLeaderboard = async (req, res, next) => { try { ok(res, req, await service.trainerLeaderboard(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); } };

// ---- Student ----
export const studentTests = async (req, res, next) => { try { ok(res, req, await service.studentTests(req.tenant, req.student.id)); } catch (e) { next(e); } };
export const takeTest = async (req, res, next) => { try { ok(res, req, await service.takeTest(req.tenant, req.student.id, req.params.id)); } catch (e) { next(e); } };
export const submitTest = async (req, res, next) => { try { ok(res, req, await service.submitTest(req.tenant, req.student.id, req.params.id, req.body.answers), 201); } catch (e) { next(e); } };
export const studentProjects = async (req, res, next) => { try { ok(res, req, await service.studentProjects(req.tenant, req.student.id)); } catch (e) { next(e); } };
export const submitProject = async (req, res, next) => { try { ok(res, req, await service.submitProject(req.tenant, req.student.id, req.params.id, req.body), 201); } catch (e) { next(e); } };
export const studentLeaderboard = async (req, res, next) => { try { ok(res, req, await service.studentLeaderboard(req.tenant, req.student.id)); } catch (e) { next(e); } };
