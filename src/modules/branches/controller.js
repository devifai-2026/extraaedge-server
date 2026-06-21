import * as service from './service.js';

export const list = async (req, res, next) => {
  try {
    res.json({ data: await service.listBranches(req.tenant), meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const get = async (req, res, next) => {
  try {
    res.json({ data: await service.getBranch(req.tenant, req.params.id), meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const create = async (req, res, next) => {
  try {
    const row = await service.createBranch(req.tenant, req.body);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const adoptAll = async (req, res, next) => {
  try {
    const data = await service.createBranchAndAdopt(req.tenant, req.body);
    res.status(201).json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const row = await service.updateBranch(req.tenant, req.params.id, req.body);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try {
    await service.deleteBranch(req.tenant, req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
};

export const assignUser = async (req, res, next) => {
  try {
    const row = await service.assignUser(req.tenant, req.params.id, req.body.user_id);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const unassignUser = async (req, res, next) => {
  try {
    const row = await service.assignUser(req.tenant, null, req.params.user_id);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
