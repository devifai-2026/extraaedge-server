import * as service from './service.js';

export const list = async (req, res, next) => {
  try { res.json({ data: await service.listByType(req.tenant, req.params.type), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const create = async (req, res, next) => {
  try {
    const row = await service.createItem(req.tenant, req.params.type, req.body);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const row = await service.updateItem(req.tenant, req.params.type, req.params.id, req.body);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try { await service.removeItem(req.tenant, req.params.type, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};

export const reorder = async (req, res, next) => {
  try { await service.reorderItems(req.tenant, req.params.type, req.body.order); res.status(204).end(); }
  catch (err) { next(err); }
};
