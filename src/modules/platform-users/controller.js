import * as service from './service.js';

export const list = async (req, res, next) => {
  try { res.json({ data: await service.listPlatformUsers(), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const create = async (req, res, next) => {
  try {
    const row = await service.createPlatformUser({ input: req.body, actor: req.user });
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const row = await service.updatePlatformUser({ id: req.params.id, updates: req.body, actor: req.user });
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try {
    await service.deletePlatformUser({ id: req.params.id, actor: req.user });
    res.status(204).end();
  } catch (err) { next(err); }
};
