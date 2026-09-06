import * as service from './service.js';

export const list = async (req, res, next) => {
  try { res.json({ data: await service.listPools(req.tenant), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const get = async (req, res, next) => {
  try { res.json({ data: await service.getPool(req.tenant, req.params.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const create = async (req, res, next) => {
  try {
    const row = await service.createPool(req.tenant, req.body);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const row = await service.updatePool(req.tenant, req.params.id, req.body);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try {
    await service.deletePool(req.tenant, req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
};
