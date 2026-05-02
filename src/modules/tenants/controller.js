import * as service from './service.js';

export const create = async (req, res, next) => {
  try {
    const tenant = await service.createTenant({
      input: req.body,
      platform_user_id: req.user.id,
      ip: req.ip,
      user_agent: req.headers['user-agent'],
    });
    res.status(201).json({ data: tenant, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const list = async (req, res, next) => {
  try {
    const { rows, total } = await service.listTenants(req.query);
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit, total } });
  } catch (err) { next(err); }
};

export const getOne = async (req, res, next) => {
  try { res.json({ data: await service.getTenant(req.params.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try { res.json({ data: await service.updateTenant(req.params.id, req.body), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const suspend = async (req, res, next) => {
  try {
    const row = await service.suspendTenant(req.params.id, req.user.id, req.ip, req.headers['user-agent']);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const resume = async (req, res, next) => {
  try {
    const row = await service.resumeTenant(req.params.id, req.user.id, req.ip, req.headers['user-agent']);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
