import * as service from './service.js';

export const login = async (req, res, next) => {
  try {
    const data = await service.login(req.tenant, req.body);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const setPassword = async (req, res, next) => {
  try {
    const data = await service.setPassword(req.tenant, req.body);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const requestReset = async (req, res, next) => {
  try {
    const data = await service.requestReset(req.tenant, req.body);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const me = async (req, res, next) => {
  try {
    const data = await service.me(req.tenant, req.student.id);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
