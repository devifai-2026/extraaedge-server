import * as service from './service.js';

const ok = (res, req, data) => res.json({ data, meta: { requestId: req.id } });

export const myPayments = async (req, res, next) => {
  try { ok(res, req, await service.myPayments(req.tenant, req.student.id)); } catch (e) { next(e); }
};

export const myReceiptToken = async (req, res, next) => {
  try { ok(res, req, await service.myReceiptToken(req.tenant, req.student.id, req.params.id)); } catch (e) { next(e); }
};
