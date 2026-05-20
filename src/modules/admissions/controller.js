import * as service from './service.js';

// ---------- Admissions ----------
export const list = async (req, res, next) => {
  try {
    const { rows, total } = await service.list(req.tenant, req.query);
    res.json({ data: rows, meta: { requestId: req.id, total, page: req.query.page, limit: req.query.limit } });
  } catch (err) { next(err); }
};

export const get = async (req, res, next) => {
  try {
    const row = await service.get(req.tenant, req.params.id);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const create = async (req, res, next) => {
  try {
    const row = await service.create(req.tenant, req.user, req.body);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const row = await service.update(req.tenant, req.params.id, req.body);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try { await service.remove(req.tenant, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};

export const approve = async (req, res, next) => {
  try {
    const row = await service.approve(req.tenant, req.user, req.params.id);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const markBreak = async (req, res, next) => {
  try {
    const row = await service.setStatus(req.tenant, req.params.id, 'on_break', { break_reason: req.body?.reason });
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const resume = async (req, res, next) => {
  try {
    const row = await service.setStatus(req.tenant, req.params.id, 'attending');
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const complete = async (req, res, next) => {
  try {
    const row = await service.setStatus(req.tenant, req.params.id, 'completed');
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

// ---------- Receipts ----------
export const listReceipts = async (req, res, next) => {
  try {
    const rows = await service.listReceipts(req.tenant, req.query);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const createReceipt = async (req, res, next) => {
  try {
    const row = await service.createReceipt(req.tenant, req.user, req.params.id, req.body);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const deleteReceipt = async (req, res, next) => {
  try { await service.deleteReceipt(req.tenant, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};

// ---------- Reports ----------
export const paySchedule = async (req, res, next) => {
  try {
    const data = await service.paySchedule(req.tenant, req.query);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const collectionReceiptWise = async (req, res, next) => {
  try {
    const data = await service.collectionReceiptWise(req.tenant, req.query);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const dashboard = async (req, res, next) => {
  try {
    const days = Math.max(7, Math.min(365, Number(req.query.trend_days) || 30));
    const data = await service.dashboardWithCharts(req.tenant, { trend_days: days });
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const pendingAdmissions = async (req, res, next) => {
  try {
    const rows = await service.pendingAdmissions(req.tenant);
    res.json({
      data: rows,
      meta: { requestId: req.id, total: rows.length },
    });
  } catch (err) { next(err); }
};

export const pendingAdmissionsCount = async (req, res, next) => {
  try {
    const pending = await service.pendingAdmissionsCount(req.tenant);
    res.json({ data: { pending }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

// ---------- Centers ----------
export const listCenters = async (req, res, next) => {
  try { res.json({ data: await service.listCenters(req.tenant), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};
export const createCenter = async (req, res, next) => {
  try { res.status(201).json({ data: await service.createCenter(req.tenant, req.body), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};
export const updateCenter = async (req, res, next) => {
  try { res.json({ data: await service.updateCenter(req.tenant, req.params.id, req.body), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};
export const deleteCenter = async (req, res, next) => {
  try { await service.deleteCenter(req.tenant, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};
