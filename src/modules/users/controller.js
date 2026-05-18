import * as service from './service.js';

export const list = async (req, res, next) => {
  try {
    const { rows, total } = await service.listUsers(req.tenant, req.query);
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit, total } });
  } catch (err) { next(err); }
};

export const get = async (req, res, next) => {
  try { res.json({ data: await service.getUser(req.tenant, req.params.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const create = async (req, res, next) => {
  try {
    const row = await service.createUser(req.tenant, req.body, req.user);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const row = await service.updateUser(req.tenant, req.params.id, req.body, req.user);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try {
    await service.deleteUser(req.tenant, req.params.id, req.user);
    res.status(204).end();
  } catch (err) { next(err); }
};

export const resetPassword = async (req, res, next) => {
  try {
    await service.resetPassword(req.tenant, req.params.id, req.body.new_password);
    res.status(204).end();
  } catch (err) { next(err); }
};

export const updatePermissions = async (req, res, next) => {
  try {
    const row = await service.updatePermissions(req.tenant, req.params.id, req.body.permissions_json);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const myTeam = async (req, res, next) => {
  try { res.json({ data: await service.myTeam(req.tenant, req.user.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const userLeads = async (req, res, next) => {
  try {
    const status = req.query.status === 'past' ? 'past' : 'current';
    const data = await service.userLeads(req.tenant, req.params.id, { status, limit: Number(req.query.limit) || 100 });
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const userWorkSessions = async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 180);
    const data = await service.userWorkSessions(req.tenant, req.params.id, { days });
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const userLoginEvents = async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 180);
    const data = await service.userLoginEvents(req.tenant, req.params.id, { days });
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const orgTree = async (req, res, next) => {
  try {
    const data = await service.orgTree(req.tenant, req.user);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const updateMyTheme = async (req, res, next) => {
  try {
    const data = await service.updateMyTheme(req.tenant, req.user, req.body);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
