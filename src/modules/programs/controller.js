import * as service from './service.js';

export const list = async (req, res, next) => {
  try {
    const { rows, total } = await service.listPrograms(req.tenant, req.query);
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit, total } });
  } catch (err) { next(err); }
};

export const get = async (req, res, next) => {
  try { res.json({ data: await service.getProgram(req.tenant, req.params.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const create = async (req, res, next) => {
  try {
    const row = await service.createProgram(req.tenant, req.body);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const row = await service.updateProgram(req.tenant, req.params.id, req.body);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try { await service.deleteProgram(req.tenant, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};
