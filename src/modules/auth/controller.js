import * as service from './service.js';

export const login = async (req, res, next) => {
  try {
    const result = await service.login({ ...req.body, ip: req.ip, user_agent: req.headers['user-agent'] });
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const refresh = async (req, res, next) => {
  try {
    const result = await service.refresh({
      refresh_token: req.body.refresh_token,
      ip: req.ip,
      user_agent: req.headers['user-agent'],
    });
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

// Counsellor recorder app login (institute code + profile phone + OTP).
export const loginMethods = async (req, res, next) => {
  try {
    res.json({ data: await service.loginMethods({ tenant_slug: req.query.tenant_slug }), meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const webRequestOtp = async (req, res, next) => {
  try {
    res.json({ data: await service.requestWebLoginOtp(req.body), meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const webVerifyOtp = async (req, res, next) => {
  try {
    const result = await service.verifyWebLoginOtp({
      ...req.body,
      ip: req.ip,
      user_agent: req.headers['user-agent'],
    });
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const mobileRequestOtp = async (req, res, next) => {
  try {
    const result = await service.requestMobileLoginOtp(req.body);
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const mobileVerifyOtp = async (req, res, next) => {
  try {
    const result = await service.verifyMobileLoginOtp({
      ...req.body,
      ip: req.ip,
      user_agent: req.headers['user-agent'],
    });
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const logout = async (req, res, next) => {
  try {
    await service.logout({ user: req.user });
    res.status(204).end();
  } catch (err) { next(err); }
};

export const me = async (req, res, next) => {
  try { res.json({ data: await service.me({ user: req.user }), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const heartbeat = async (req, res, next) => {
  try { res.json({ data: await service.heartbeat({ user: req.user }), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const updateLocation = async (req, res, next) => {
  try {
    await service.updateLocation({ user: req.user, lat: req.body.lat, lng: req.body.lng });
    res.status(204).end();
  } catch (err) { next(err); }
};

export const changePassword = async (req, res, next) => {
  try {
    await service.changePassword({
      user: req.user,
      current_password: req.body.current_password,
      new_password: req.body.new_password,
    });
    res.status(204).end();
  } catch (err) { next(err); }
};
