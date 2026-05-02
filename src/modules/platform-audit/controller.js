// Platform audit log controllers.
import * as service from './service.js';

export const list = async (req, res, next) => {
  try {
    const { rows, total, page, limit } = await service.listEntries(req.query);
    res.json({ data: rows, meta: { requestId: req.id, page, limit, total } });
  } catch (err) { next(err); }
};
