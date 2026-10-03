import * as service from './service.js';

export const start = async (req, res, next) => {
  try {
    const data = await service.startViewAs({
      tenant: req.tenant,
      actor: req.user,
      input: req.body,
      ip: req.ip,
      user_agent: req.headers['user-agent'],
    });
    res.status(201).json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const stop = async (req, res, next) => {
  try {
    const data = await service.stopViewAs({ tenant: req.tenant, actor: req.user });
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const list = async (req, res, next) => {
  try {
    const { rows, total } = await service.listSessions(req.tenant, req.query, req.user);
    res.json({ data: rows, meta: { requestId: req.id, total, page: req.query.page, limit: req.query.limit } });
  } catch (err) { next(err); }
};
