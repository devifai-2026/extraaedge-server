import * as service from './service.js';

export const get = async (req, res, next) => {
  try { res.json({ data: await service.getPrefs(req.tenant, req.user.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const row = await service.updatePrefs(req.tenant, req.user.id, req.body);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
