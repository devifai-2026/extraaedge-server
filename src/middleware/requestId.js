import { nanoid } from 'nanoid';

export const requestId = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && incoming.length > 0 ? incoming : nanoid(16);
  res.setHeader('X-Request-Id', req.id);
  next();
};
