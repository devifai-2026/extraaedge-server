import * as service from './service.js';

export const start = async (req, res, next) => {
  try {
    const result = await service.startImpersonation({
      actor: req.user,
      input: req.body,
      ip: req.ip,
      user_agent: req.headers['user-agent'],
    });
    res.status(201).json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const stop = async (req, res, next) => {
  try {
    const session_id = req.user.impersonationSessionId ?? req.user.sessionId;
    const ended = await service.stopImpersonation({
      session_id,
      actor: req.user,
      ip: req.ip,
      user_agent: req.headers['user-agent'],
    });
    res.json({ data: ended, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const list = async (req, res, next) => {
  try { res.json({ data: await service.listSessions(req.query), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};
