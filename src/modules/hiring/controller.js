// Speedup Hiring — thin HTTP layer.
import * as service from './service.js';
import { notFound } from '../../lib/errors.js';

const ok = (res, req, data) => res.json({ data, meta: { requestId: req.id } });

// ---------- statuses ----------
export const listStatuses = async (req, res, next) => {
  try { ok(res, req, await service.listStatuses(req.tenant, { includeInactive: req.query.all === 'true' })); } catch (e) { next(e); }
};
export const createStatus = async (req, res, next) => {
  try { ok(res, req, await service.createStatus(req.tenant, req.body)); } catch (e) { next(e); }
};
export const updateStatus = async (req, res, next) => {
  try {
    const r = await service.updateStatus(req.tenant, req.params.id, req.body);
    if (!r) throw notFound('Status not found');
    ok(res, req, r);
  } catch (e) { next(e); }
};

// ---------- positions ----------
export const listPositions = async (req, res, next) => {
  try { ok(res, req, await service.listPositions(req.tenant, req.query)); } catch (e) { next(e); }
};
export const createPosition = async (req, res, next) => {
  try { ok(res, req, await service.createPosition(req.tenant, req.body, req.user?.id)); } catch (e) { next(e); }
};
export const updatePosition = async (req, res, next) => {
  try {
    const r = await service.updatePosition(req.tenant, req.params.id, req.body);
    if (!r) throw notFound('Position not found');
    ok(res, req, r);
  } catch (e) { next(e); }
};
export const deletePosition = async (req, res, next) => {
  try { await service.softDeletePosition(req.tenant, req.params.id); ok(res, req, { deleted: true }); } catch (e) { next(e); }
};

// ---------- postings ----------
export const listPostings = async (req, res, next) => {
  try { ok(res, req, await service.listPostings(req.tenant, req.params.id)); } catch (e) { next(e); }
};
export const createPosting = async (req, res, next) => {
  try {
    ok(res, req, await service.createPosting(
      req.tenant, { ...req.body, position_id: req.params.id }, req.user?.id,
    ));
  } catch (e) { next(e); }
};
export const deletePosting = async (req, res, next) => {
  try { await service.softDeletePosting(req.tenant, req.params.id); ok(res, req, { deleted: true }); } catch (e) { next(e); }
};

// ---------- candidates ----------
export const listCandidates = async (req, res, next) => {
  try {
    const { rows, total } = await service.listCandidates(req.tenant, req.query);
    res.json({ data: rows, meta: { total, requestId: req.id } });
  } catch (e) { next(e); }
};
export const getCandidate = async (req, res, next) => {
  try {
    const r = await service.getCandidate(req.tenant, req.params.id);
    if (!r) throw notFound('Candidate not found');
    ok(res, req, r);
  } catch (e) { next(e); }
};
export const createCandidate = async (req, res, next) => {
  try { ok(res, req, await service.createCandidate(req.tenant, req.body, req.user?.id)); } catch (e) { next(e); }
};
export const updateCandidate = async (req, res, next) => {
  try {
    const r = await service.updateCandidate(req.tenant, req.params.id, req.body);
    if (!r) throw notFound('Candidate not found');
    ok(res, req, r);
  } catch (e) { next(e); }
};
export const deleteCandidate = async (req, res, next) => {
  try { await service.softDeleteCandidate(req.tenant, req.params.id); ok(res, req, { deleted: true }); } catch (e) { next(e); }
};
export const setCandidateStatus = async (req, res, next) => {
  try { ok(res, req, await service.setCandidateStatus(req.tenant, req.user, req.params.id, req.body)); } catch (e) { next(e); }
};

// ---------- interviews ----------
export const listInterviews = async (req, res, next) => {
  try { ok(res, req, await service.listInterviews(req.tenant, req.query)); } catch (e) { next(e); }
};
export const createInterview = async (req, res, next) => {
  try {
    const { panel_user_ids: panel, ...body } = req.body;
    const row = await service.createInterview(req.tenant, body, req.user?.id);
    // The form edits the panel alongside the interview, so accept it on the
    // same request rather than making the UI fire a second call it could fail
    // to send — leaving an interview with nobody on it.
    if (Array.isArray(panel)) await service.setPanel(req.tenant, row.id, panel, req.user?.id);
    ok(res, req, { ...row, panel: await service.listPanel(req.tenant, row.id) });
  } catch (e) { next(e); }
};
export const updateInterview = async (req, res, next) => {
  try {
    const { panel_user_ids: panel, ...body } = req.body;
    const r = await service.updateInterview(req.tenant, req.params.id, body);
    if (!r) throw notFound('Interview not found');
    if (Array.isArray(panel)) await service.setPanel(req.tenant, r.id, panel, req.user?.id);
    ok(res, req, { ...r, panel: await service.listPanel(req.tenant, r.id) });
  } catch (e) { next(e); }
};
export const deleteInterview = async (req, res, next) => {
  try { await service.softDeleteInterview(req.tenant, req.params.id); ok(res, req, { deleted: true }); } catch (e) { next(e); }
};

// ---------- bulk import ----------
// Preview and commit are separate calls on purpose: the recruiter sees the
// per-row verdict and the new/update split BEFORE anything is written.
export const previewCandidateImport = async (req, res, next) => {
  try {
    const r = await service.previewCandidates(req.tenant, req.body);
    ok(res, req, { ...r, rows: undefined });
  } catch (e) { next(e); }
};
export const commitCandidateImport = async (req, res, next) => {
  try { ok(res, req, await service.importCandidates(req.tenant, req.user, req.body)); } catch (e) { next(e); }
};
export const previewInterviewImport = async (req, res, next) => {
  try {
    const r = await service.previewInterviews(req.tenant, req.body);
    ok(res, req, { ...r, rows: undefined });
  } catch (e) { next(e); }
};
export const commitInterviewImport = async (req, res, next) => {
  try { ok(res, req, await service.importInterviews(req.tenant, req.user, req.body)); } catch (e) { next(e); }
};

// ---------- spreadsheet reading ----------
export const workbookSheets = async (req, res, next) => {
  try { ok(res, req, await service.sheetsInWorkbook(req.body.file_key)); } catch (e) { next(e); }
};

// ---------- async import ----------
export const queueImport = async (req, res, next) => {
  try {
    const job = await service.queueImport(req.tenant, req.user, req.body);
    res.status(202).json({ data: job, meta: { requestId: req.id } });
  } catch (e) { next(e); }
};
export const listImports = async (req, res, next) => {
  try { ok(res, req, await service.listImports(req.tenant, req.query)); } catch (e) { next(e); }
};
export const getImport = async (req, res, next) => {
  try {
    const r = await service.getImport(req.tenant, req.params.id);
    if (!r) throw notFound('Import not found');
    ok(res, req, r);
  } catch (e) { next(e); }
};
export const importRows = async (req, res, next) => {
  try { ok(res, req, await service.importRows(req.tenant, req.params.id, req.query.outcome)); } catch (e) { next(e); }
};

// ---------- dashboard ----------
export const dashboard = async (req, res, next) => {
  try { ok(res, req, await service.dashboard(req.tenant)); } catch (e) { next(e); }
};

// ---------- rounds / panel / feedback ----------

export const listRounds = async (req, res, next) => {
  try { ok(res, req, await service.listRounds(req.tenant)); } catch (e) { next(e); }
};

export const listPanel = async (req, res, next) => {
  try { ok(res, req, await service.listPanel(req.tenant, req.params.id)); } catch (e) { next(e); }
};

export const setPanel = async (req, res, next) => {
  try {
    await service.setPanel(req.tenant, req.params.id, req.body.user_ids, req.user?.id);
    ok(res, req, await service.listPanel(req.tenant, req.params.id));
  } catch (e) { next(e); }
};

// Interviews the CALLER sits on. Scoped to req.user.id, never a query param,
// so this cannot be turned into "show me someone else's schedule".
export const listMyInterviews = async (req, res, next) => {
  try { ok(res, req, await service.listMyInterviews(req.tenant, req.user.id, req.query)); } catch (e) { next(e); }
};

export const listFeedback = async (req, res, next) => {
  try { ok(res, req, await service.listFeedback(req.tenant, req.params.id, req.user)); } catch (e) { next(e); }
};

// A panellist writes their OWN verdict: the author is req.user.id, so one
// panellist can never post or overwrite another's.
export const submitFeedback = async (req, res, next) => {
  try { ok(res, req, await service.submitFeedback(req.tenant, req.params.id, req.user, req.body)); } catch (e) { next(e); }
};
