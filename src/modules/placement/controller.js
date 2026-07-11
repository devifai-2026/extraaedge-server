import * as service from './service.js';

const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

// Companies
export const listCompanies = async (req, res, next) => { try { ok(res, req, await service.listCompanies(req.tenant, req.user, req.query.branch_id || null)); } catch (e) { next(e); } };
export const createCompany = async (req, res, next) => { try { ok(res, req, await service.createCompany(req.tenant, req.user, req.body), 201); } catch (e) { next(e); } };
export const updateCompany = async (req, res, next) => { try { ok(res, req, await service.updateCompany(req.tenant, req.user, req.params.id, req.body)); } catch (e) { next(e); } };
export const deleteCompany = async (req, res, next) => { try { ok(res, req, await service.deleteCompany(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const bulkCreateCompanies = async (req, res, next) => { try { ok(res, req, await service.bulkCreateCompanies(req.tenant, req.user, req.body.rows, req.body?.branch_id || req.query.branch_id || null), 201); } catch (e) { next(e); } };

// Openings
export const listOpenings = async (req, res, next) => { try { ok(res, req, await service.listOpenings(req.tenant, req.user, req.query.status, req.query.branch_id || null)); } catch (e) { next(e); } };
export const createOpening = async (req, res, next) => { try { ok(res, req, await service.createOpening(req.tenant, req.user, req.body), 201); } catch (e) { next(e); } };
export const setOpeningStatus = async (req, res, next) => { try { ok(res, req, await service.setOpeningStatus(req.tenant, req.user, req.params.id, req.body.status)); } catch (e) { next(e); } };
export const deleteOpening = async (req, res, next) => { try { ok(res, req, await service.deleteOpening(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const previewAudience = async (req, res, next) => { try { ok(res, req, await service.previewAudience(req.tenant, req.user, req.params.id, req.query.branch_id || null)); } catch (e) { next(e); } };
export const fire = async (req, res, next) => { try { ok(res, req, await service.fire(req.tenant, req.user, req.params.id, req.body?.branch_id || null), 201); } catch (e) { next(e); } };
export const counts = async (req, res, next) => { try { ok(res, req, await service.counts(req.tenant, req.user, req.query.branch_id || null)); } catch (e) { next(e); } };
export const programModules = async (req, res, next) => { try { ok(res, req, await service.programModules(req.tenant, req.params.programId)); } catch (e) { next(e); } };

// Applications
export const listApplications = async (req, res, next) => { try { ok(res, req, await service.listApplications(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const setApplicationStatus = async (req, res, next) => { try { ok(res, req, await service.setApplicationStatus(req.tenant, req.user, req.params.id, req.body.status, req.body.note, req.body.offer_ctc)); } catch (e) { next(e); } };

// Dynamic stages
export const listStages = async (req, res, next) => { try { ok(res, req, await service.listStages(req.tenant, req.user, req.query.branch_id)); } catch (e) { next(e); } };
export const createStage = async (req, res, next) => { try { ok(res, req, await service.createStage(req.tenant, req.user, req.body), 201); } catch (e) { next(e); } };
export const updateStage = async (req, res, next) => { try { ok(res, req, await service.updateStage(req.tenant, req.user, req.params.id, req.body)); } catch (e) { next(e); } };
export const deleteStage = async (req, res, next) => { try { ok(res, req, await service.deleteStage(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const moveStage = async (req, res, next) => { try { ok(res, req, await service.moveStage(req.tenant, req.user, req.params.id, req.body.stage_id, req.body.reason)); } catch (e) { next(e); } };
export const applicationHistory = async (req, res, next) => { try { ok(res, req, await service.applicationHistory(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const studentReport = async (req, res, next) => { try { ok(res, req, await service.studentReport(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };

// Student
export const studentFeed = async (req, res, next) => { try { ok(res, req, await service.studentFeed(req.tenant, req.student.id)); } catch (e) { next(e); } };
export const applyToOpening = async (req, res, next) => { try { ok(res, req, await service.applyToOpening(req.tenant, req.student.id, req.params.id), 201); } catch (e) { next(e); } };
