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

// ---- Profile (student) ----
export const getProfile = async (req, res, next) => {
  try { res.json({ data: await service.getProfile(req.tenant, req.student.id), meta: { requestId: req.id } }); } catch (e) { next(e); }
};
export const updateProfile = async (req, res, next) => {
  try { res.json({ data: await service.updateProfile(req.tenant, req.student.id, req.body), meta: { requestId: req.id } }); } catch (e) { next(e); }
};
export const presign = async (req, res, next) => {
  try { res.json({ data: await service.presign(req.tenant, req.student.id, req.body), meta: { requestId: req.id } }); } catch (e) { next(e); }
};
export const setCv = async (req, res, next) => {
  try { res.json({ data: await service.setCv(req.tenant, req.student.id, req.body.r2_key, req.body.filename), meta: { requestId: req.id } }); } catch (e) { next(e); }
};

// ---- Trainer view (staff) ----
export const trainerViewProfile = async (req, res, next) => {
  try { res.json({ data: await service.trainerViewProfile(req.tenant, req.user, req.params.studentId), meta: { requestId: req.id } }); } catch (e) { next(e); }
};
