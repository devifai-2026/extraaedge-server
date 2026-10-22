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

export const remove = async (req, res, next) => {
  try {
    await service.deleteTenant(req.params.id, req.user.id, req.ip, req.headers['user-agent']);
    res.status(204).end();
  } catch (err) { next(err); }
};

export const orgTree = async (req, res, next) => {
  try {
    const tree = await service.getOrgTree(req.params.id);
    res.json({ data: tree, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

// Switch how this tenant's users sign in: otp | password | both.
export const setAuthMode = async (req, res, next) => {
  try {
    const row = await service.setAuthMode(req.params.id, req.body.auth_mode, {
      platform_user_id: req.user.id, ip: req.ip, user_agent: req.headers['user-agent'],
    });
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

// The tenant's super admin + whether a password is currently set. Never
// returns the hash — there is nothing to "view" but the account itself.
export const getAdmin = async (req, res, next) => {
  try {
    const row = await service.getTenantAdmin(req.params.id);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

// Set or rotate the super admin's password. The plaintext comes back once —
// see service.setTenantAdminPassword for why it cannot be re-read later.
export const setAdminPassword = async (req, res, next) => {
  try {
    const out = await service.setTenantAdminPassword(req.params.id, req.body ?? {}, {
      platform_user_id: req.user.id, ip: req.ip, user_agent: req.headers['user-agent'],
    });
    res.json({ data: out, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
