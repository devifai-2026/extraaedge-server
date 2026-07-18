// API → WhatsApp gateway client. Thin fetch wrappers over the gateway's
// internal REST, authenticated with the shared secret. The gateway is the only
// holder of live whatsapp-web.js Clients; the user-facing API module proxies
// every connect/status/send/logout through here.
//
// Base-URL selection is intentionally a single function so this can later be
// sharded across multiple gateway processes (route by hash of tenantId:userId)
// without touching callers.
import { env } from '../config/env.js';
import { appError } from './errors.js';
import { RESPONSE_CODES } from '../config/constants.js';

const baseUrl = (/* tenantId, userId */) => env.WA_GATEWAY_URL;

const call = async (method, pathSuffix, body) => {
  let res;
  try {
    res = await fetch(`${baseUrl()}${pathSuffix}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': env.WA_GATEWAY_INTERNAL_SECRET,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw appError({ status: 503, code: RESPONSE_CODES.INTERNAL, message: 'WhatsApp gateway unavailable', cause: err });
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // Surface the gateway's NOT_CONNECTED as a 409 the FE can act on.
    if (res.status === 409 && json?.error?.code === 'NOT_CONNECTED') {
      throw appError({ status: 409, code: 'NOT_CONNECTED', message: 'WhatsApp not connected' });
    }
    // Number not on WhatsApp → 422 so the FE can tell the user clearly.
    if (res.status === 422 && json?.error?.code === 'NOT_ON_WHATSAPP') {
      throw appError({ status: 422, code: 'NOT_ON_WHATSAPP', message: 'This number is not on WhatsApp' });
    }
    throw appError({ status: 502, code: RESPONSE_CODES.INTERNAL, message: json?.error?.message || 'WhatsApp gateway error' });
  }
  return json;
};

export const startSession = (tenantId, userId, tenantSlug) =>
  call('POST', `/sessions/${tenantId}/${userId}/start`, { tenantSlug });

export const getStatus = (tenantId, userId) =>
  call('GET', `/sessions/${tenantId}/${userId}/status`);

// `media`, when present, is { signedUrl, filename, mimetype } — the gateway
// fetches the signed URL into a MessageMedia and sends `body` as the caption.
export const sendMessage = (tenantId, userId, { to, body, media }) =>
  call('POST', `/sessions/${tenantId}/${userId}/send`, { to, body, media });

export const logoutSession = (tenantId, userId) =>
  call('POST', `/sessions/${tenantId}/${userId}/logout`);
