import * as repo from './repo.js';
import { notFound } from '../../lib/errors.js';

export const list = async (req, res, next) => {
  try {
    const result = await repo.listAndCount(req.query);
    res.json({
      data: result.rows,
      meta: { requestId: req.id, total: result.total, page: result.page, limit: result.limit },
    });
  } catch (err) { next(err); }
};

export const detail = async (req, res, next) => {
  try {
    const row = await repo.getById(req.params.id);
    if (!row) throw notFound('Request log entry not found');
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const facets = async (req, res, next) => {
  try {
    const data = await repo.facets();
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
