import * as service from './service.js';
import * as publicService from '../public-admissions/service.js';

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

// Mint (or re-mint) a 24h public share-link for a converted lead's
// admission form. Returns just the token + expiry; the FE assembles the
// final URL using its own origin so this works across environments.
export const generateShareLink = async (req, res, next) => {
  try {
    const data = await publicService.generateLink(req.tenant, req.user, req.params.leadId);
    res.status(201).json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const row = await service.update(req.tenant, req.params.id, req.body, req.user);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

// Timeline for a single admission. Open to the same role gate as the
// rest of the admissions router (account_manager + super_admin).
export const timeline = async (req, res, next) => {
  try {
    const data = await service.timeline(req.tenant, req.params.id);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

// Lookup helper for the lead drawer.
export const timelineByLead = async (req, res, next) => {
  try {
    const data = await service.timelineByLead(req.tenant, req.params.leadId);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

// Tenant-wide admission status snapshot — powers the new Admission
// Pipeline sidebar page + the dashboard cards.
export const leadStatusSnapshot = async (req, res, next) => {
  try {
    const data = await service.leadStatusSnapshot(req.tenant);
    res.json({ data, meta: { requestId: req.id } });
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

export const reject = async (req, res, next) => {
  try {
    const row = await service.reject(req.tenant, req.user, req.params.id, req.body?.reason);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const markBreak = async (req, res, next) => {
  try {
    const row = await service.setStatus(req.tenant, req.params.id, 'on_break', { break_reason: req.body?.reason }, req.user);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const resume = async (req, res, next) => {
  try {
    const row = await service.setStatus(req.tenant, req.params.id, 'attending', undefined, req.user);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const complete = async (req, res, next) => {
  try {
    const row = await service.setStatus(req.tenant, req.params.id, 'completed', undefined, req.user);
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

// Upcoming + overdue installments for the Accounts Dashboard EMI widgets.
// `?days=N` controls the upcoming window; defaults to 7.
export const emiDigest = async (req, res, next) => {
  try {
    const upcomingDays = Math.max(1, Math.min(30, Number(req.query?.days) || 7));
    const rows = await service.emiDigest(req.tenant, upcomingDays);
    res.json({ data: rows, meta: { requestId: req.id, upcomingDays, total: rows.length } });
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
