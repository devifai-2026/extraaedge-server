import * as service from './service.js';

const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

// Student
export const studentAssignments = async (req, res, next) => { try { ok(res, req, await service.studentAssignments(req.tenant, req.student.id)); } catch (e) { next(e); } };
export const submit = async (req, res, next) => { try { ok(res, req, await service.submit(req.tenant, req.student.id, req.params.id, req.body), 201); } catch (e) { next(e); } };

// Trainer / admin
export const list = async (req, res, next) => { try { ok(res, req, await service.list(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); } };
export const create = async (req, res, next) => { try { ok(res, req, await service.create(req.tenant, req.user, req.body), 201); } catch (e) { next(e); } };
export const remove = async (req, res, next) => { try { ok(res, req, await service.remove(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const listSubmissions = async (req, res, next) => { try { ok(res, req, await service.listSubmissions(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const grade = async (req, res, next) => { try { ok(res, req, await service.grade(req.tenant, req.user, req.body.submission_id, req.body.marks, req.body.feedback)); } catch (e) { next(e); } };
