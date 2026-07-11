// Thin controllers for the learning module — unwrap req, call service, wrap the
// uniform { data, meta } envelope. Trainer handlers pass req.user; student
// handlers pass req.student.id (never a body-supplied id).
import * as service from './service.js';

const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

// ---- Materials (trainer/admin) ----
export const listMaterials = async (req, res, next) => { try { ok(res, req, await service.listMaterials(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); } };
export const createMaterial = async (req, res, next) => { try { ok(res, req, await service.createMaterial(req.tenant, req.user, req.body), 201); } catch (e) { next(e); } };
export const deleteMaterial = async (req, res, next) => { try { ok(res, req, await service.deleteMaterial(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const trainerMaterialUrl = async (req, res, next) => { try { ok(res, req, await service.trainerMaterialUrl(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };

// ---- Progress (trainer/admin) ----
export const trainerProgress = async (req, res, next) => { try { ok(res, req, await service.trainerProgress(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); } };

// ---- Certificates (trainer/admin) ----
export const listCertificates = async (req, res, next) => { try { ok(res, req, await service.listCertificates(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); } };
export const issueCertificate = async (req, res, next) => { try { ok(res, req, await service.issueCertificateFor(req.tenant, req.user, req.body.program_id, req.body.student_id), 201); } catch (e) { next(e); } };

// ---- Materials (student) ----
export const studentMaterials = async (req, res, next) => { try { ok(res, req, await service.studentMaterials(req.tenant, req.student.id)); } catch (e) { next(e); } };
export const studentMaterialUrl = async (req, res, next) => { try { ok(res, req, await service.studentMaterialUrl(req.tenant, req.student.id, req.params.id)); } catch (e) { next(e); } };

// ---- Progress (student) ----
export const studentProgress = async (req, res, next) => { try { ok(res, req, await service.studentProgress(req.tenant, req.student.id)); } catch (e) { next(e); } };
export const setStudentProgress = async (req, res, next) => { try { ok(res, req, await service.setStudentProgress(req.tenant, req.student.id, req.params.moduleId, req.body.completed)); } catch (e) { next(e); } };

// ---- Certificate (student) ----
export const studentCertificate = async (req, res, next) => { try { ok(res, req, await service.getCertificateView(req.tenant, req.student.id)); } catch (e) { next(e); } };
export const claimCertificate = async (req, res, next) => { try { ok(res, req, await service.claimCertificate(req.tenant, req.student.id), 201); } catch (e) { next(e); } };

// ---- Gamification (student dashboard) ----
export const studentHomeExtras = async (req, res, next) => { try { ok(res, req, await service.studentHomeExtras(req.tenant, req.student.id)); } catch (e) { next(e); } };
