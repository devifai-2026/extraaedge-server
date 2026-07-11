import * as service from './service.js';

const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

export const create = async (req, res, next) => { try { ok(res, req, await service.create(req.tenant, req.user, req.body), 201); } catch (e) { next(e); } };
export const list = async (req, res, next) => { try { ok(res, req, await service.list(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); } };
export const programStudents = async (req, res, next) => { try { ok(res, req, await service.programStudents(req.tenant, req.user, req.query.programId)); } catch (e) { next(e); } };
export const listSlots = async (req, res, next) => { try { ok(res, req, await service.listSlots(req.tenant, req.user, req.params.id)); } catch (e) { next(e); } };
export const assignSlot = async (req, res, next) => { try { ok(res, req, await service.assignSlot(req.tenant, req.user, req.params.id, req.body.student_id, req.body.slot_at), 201); } catch (e) { next(e); } };
export const gradeSlot = async (req, res, next) => { try { ok(res, req, await service.gradeSlot(req.tenant, req.user, req.params.slotId, req.body.marks, req.body.feedback)); } catch (e) { next(e); } };
export const assignableHr = async (req, res, next) => { try { ok(res, req, await service.assignableHr(req.tenant, req.user)); } catch (e) { next(e); } };
export const assignHr = async (req, res, next) => { try { ok(res, req, await service.assignHr(req.tenant, req.user, req.params.id, req.body.hr_user_id)); } catch (e) { next(e); } };
export const scoreSlot = async (req, res, next) => { try { ok(res, req, await service.scoreSlot(req.tenant, req.user, req.params.slotId, req.body.scores)); } catch (e) { next(e); } };
export const hrQueue = async (req, res, next) => { try { ok(res, req, await service.hrQueue(req.tenant, req.user)); } catch (e) { next(e); } };

// Student
export const studentSlots = async (req, res, next) => { try { ok(res, req, await service.studentSlots(req.tenant, req.student.id)); } catch (e) { next(e); } };
