import * as service from './service.js';

export const list = async (req, res, next) => {
  try {
    const { rows, unread } = await service.listMine(req.tenant, req.user.id, req.query);
    res.json({ data: rows, meta: { requestId: req.id, unread, page: req.query.page, limit: req.query.limit } });
  } catch (err) { next(err); }
};

export const markRead = async (req, res, next) => {
  try { await service.markRead(req.tenant, req.user.id, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};

export const readAll = async (req, res, next) => {
  try { await service.markAllRead(req.tenant, req.user.id); res.status(204).end(); }
  catch (err) { next(err); }
};

// SSE stream — survives Nginx `proxy_buffering off`
export const stream = async (req, res, next) => {
  try {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: 'hello', at: new Date().toISOString() });

    const unsubscribe = service.subscribe(req.tenant.id, req.user.id, send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (err) { next(err); }
};
