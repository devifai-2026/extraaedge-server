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

// Whitelisted time windows → (safe interval literal, time bucket). User input is
// mapped to these constants only — never interpolated into SQL directly.
const WINDOWS = {
  '1h': { sinceExpr: '1 hour', bucket: 'minute' },
  '6h': { sinceExpr: '6 hours', bucket: 'minute' },
  '24h': { sinceExpr: '24 hours', bucket: 'hour' },
  '7d': { sinceExpr: '7 days', bucket: 'hour' },
};

export const metrics = async (req, res, next) => {
  try {
    const win = WINDOWS[req.query.window] || WINDOWS['6h'];
    const data = await repo.metrics(win);
    res.json({ data: { window: req.query.window || '6h', ...data }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
