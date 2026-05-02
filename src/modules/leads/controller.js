import * as service from './service.js';

export const list = async (req, res, next) => {
  try {
    const { rows, total } = await service.listLeads(req.tenant, req.user, req.query);
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit, total } });
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
