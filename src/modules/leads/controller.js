import * as service from './service.js';

export const list = async (req, res, next) => {
  try {
    const { rows, total } = await service.listLeads(req.tenant, req.user, req.query);
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit, total } });
  } catch (err) { next(err); }
};

export const stageCounts = async (req, res, next) => {
  try {
    const data = await service.stageCounts(req.tenant, req.user);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const autoAssignUnassigned = async (req, res, next) => {
  try {
    const data = await service.autoAssignUnassigned(req.tenant);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const bulkAssign = async (req, res, next) => {
  try {
    const result = await service.bulkAssign(req.tenant, req.user, req.body);
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const get = async (req, res, next) => {
  try { res.json({ data: await service.getLead(req.tenant, req.user, req.params.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const create = async (req, res, next) => {
  try {
    const { on_duplicate, force, ...rest } = req.body;
    const lead = await service.createLead(req.tenant, req.user, rest, { on_duplicate, force });
    res.status(201).json({ data: lead, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const lead = await service.updateLead(req.tenant, req.user, req.params.id, req.body);
    res.json({ data: lead, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try { await service.deleteLead(req.tenant, req.user, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};

// POST /leads/bulk-delete { ids: [uuid,...] }
// Hard-deletes every lead in `ids`. FK CASCADEs wipe follow-ups, notes,
// assignments, activities, family, source attributions, custom values, tags,
// calls, recordings, payments and referral edges — nothing about the lead
// survives in the tenant DB. Super-admin only (enforced at route layer).
export const bulkDelete = async (req, res, next) => {
  try {
    const result = await service.bulkDeleteLeads(req.tenant, req.user, req.body?.ids ?? []);
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const changeStage = async (req, res, next) => {
  try {
    const lead = await service.changeStage(req.tenant, req.user, req.params.id, req.body);
    res.json({ data: lead, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const timeline = async (req, res, next) => {
  try {
    const rows = await service.getTimeline(req.tenant, req.params.id, {
      limit: req.query.limit ?? 100,
      before: req.query.before,
    });
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
