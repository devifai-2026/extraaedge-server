// Push a realtime event from the gateway back to the API, which owns the only
// socket.io `io` instance and the per-user room logic. The API route
// POST /internal/wa/notify validates the shared secret and calls
// notifyUser(tenantId, userId, type, payload).
//
// Fire-and-forget: a dropped notification just means the browser will see the
// new state on its next GET /status / conversations poll. We never throw out
// of here — a notify failure must not crash a Client event handler.
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const notifyApi = async (tenantId, userId, type, payload = {}) => {
  const target = `${env.WA_API_BASE_URL}/internal/wa/notify`;
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': env.WA_GATEWAY_INTERNAL_SECRET,
      },
      body: JSON.stringify({ tenantId, userId, type, payload }),
    });
    if (!res.ok) {
      // A 401 here almost always means the secret differs between gateway and
      // API; a network error (caught below) usually means WA_API_BASE_URL is
      // unreachable (e.g. a private hostname that doesn't resolve). Log the
      // target so misconfig is obvious in the gateway logs.
      logger.warn({ tenantId, userId, type, status: res.status, target }, 'wa notify-api non-2xx');
    } else {
      logger.debug({ tenantId, userId, type, target }, 'wa notify-api ok');
    }
  } catch (err) {
    logger.error({ tenantId, userId, type, target, err: err.message }, 'wa notify-api failed — check WA_API_BASE_URL reachability');
  }
};
