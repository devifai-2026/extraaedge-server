// Captures every API request into the system-level platform_request_log so the
// product_owner "Danger Request Log" can replay exactly what a tenant did —
// method, path, account email, full (redacted) request + response bodies,
// status, and duration. Designed to be totally non-intrusive:
//   • never throws into the request lifecycle (all writes are fire-and-forget)
//   • redacts secrets before persisting
//   • caps body size so a 200kb upload doesn't bloat the log row
//
// Mounted AFTER express.json + requestId but the actor (req.user) is only
// known once auth middleware has run per-route, so we read req.user lazily at
// response time (it's populated by then for authenticated routes).
import { recordRequest } from '../services/request-log.js';
import { logger } from '../lib/logger.js';

// Keys whose values must never be persisted, anywhere in the body tree.
const SECRET_KEYS = new Set([
  'password', 'current_password', 'new_password', 'otp',
  'refresh_token', 'access_token', 'token', 'password_hash',
  'refresh_token_hash', 'credentials_encrypted', 'secret',
  'db_password', 'db_password_encrypted', 'authorization', 'cookie',
]);

const MAX_BODY_BYTES = 64 * 1024; // 64kb per body; larger → truncated text.

// Paths we never log (health/noise) or that would recurse (the log endpoint
// itself, and auth bodies which carry credentials).
const SKIP_PATH_RE = /\/(healthz|readyz|platform\/request-log)/;

const redact = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  if (depth > 8) return '[Depth limit]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
};

// Returns { json, text, truncated } — json when it fits & is an object/array,
// else text (stringified + capped). Always redacted first.
const normaliseBody = (raw) => {
  if (raw === undefined || raw === null) return { json: null, text: null, truncated: false };
  let val = raw;
  if (typeof raw === 'string') {
    try { val = JSON.parse(raw); } catch { /* keep as string */ }
  }
  if (typeof val === 'object') {
    const redacted = redact(val);
    const str = JSON.stringify(redacted);
    if (str.length <= MAX_BODY_BYTES) return { json: redacted, text: null, truncated: false };
    return { json: null, text: `${str.slice(0, MAX_BODY_BYTES)}…[truncated]`, truncated: true };
  }
  const str = String(val);
  return { json: null, text: str.slice(0, MAX_BODY_BYTES), truncated: str.length > MAX_BODY_BYTES };
};

// Best-effort request → category for high-signal filtering in the UI.
const classify = (method, path) => {
  if (/\/bulk\/leads/.test(path)) return 'bulk_import';
  if (/\/lead-assignments/.test(path) || /\/bulk\/leads\/refer/.test(path)) return 'lead_reassign';
  if (/\/leads\/bulk-assign/.test(path)) return 'lead_reassign';
  if (/\/follow-ups/.test(path)) return 'followup';
  if (/\/leads/.test(path) && method === 'POST') return 'lead_create';
  if (/\/leads/.test(path)) return 'lead';
  if (/\/auth/.test(path)) return 'auth';
  return 'other';
};

export const requestLog = (req, res, next) => {
  if (SKIP_PATH_RE.test(req.path)) return next();

  const start = process.hrtime.bigint();
  let responseCaptured;

  // Wrap res.json (the dominant response path) + res.send to grab the body.
  const origJson = res.json.bind(res);
  res.json = (body) => {
    responseCaptured = body;
    return origJson(body);
  };
  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (responseCaptured === undefined) responseCaptured = body;
    return origSend(body);
  };

  res.on('finish', () => {
    try {
      const durationMs = Number((process.hrtime.bigint() - start) / 1000000n);
      const reqBody = normaliseBody(req.body);
      const resBody = normaliseBody(responseCaptured);
      const status = res.statusCode;
      const isError = status >= 400;
      // The error handler stuffs { error: { code, message } } into the body.
      const errObj = (responseCaptured && typeof responseCaptured === 'object')
        ? responseCaptured.error : null;
      const u = req.user || {};

      // Fire-and-forget — a logging failure must never affect the response.
      recordRequest({
        request_id: req.id ?? null,
        actor_user_id: u.id ?? null,
        actor_email: u.email ?? null,
        actor_role: u.platformRole ?? u.role ?? null,
        is_platform_actor: Boolean(u.platformRole),
        tenant_id: req.tenant?.id ?? u.tenantId ?? null,
        tenant_slug: req.tenant?.slug ?? u.tenantSlug ?? null,
        method: req.method,
        path: req.originalUrl?.split('?')[0] ?? req.path,
        route: req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : null,
        query_json: req.query && Object.keys(req.query).length ? redact(req.query) : null,
        status_code: status,
        duration_ms: durationMs,
        request_body: reqBody.json,
        request_body_text: reqBody.text,
        response_body: resBody.json,
        response_body_text: resBody.text,
        body_truncated: reqBody.truncated || resBody.truncated,
        is_error: isError,
        error_code: isError ? (errObj?.code ?? null) : null,
        error_message: isError ? (errObj?.message ?? null) : null,
        category: classify(req.method, req.path),
        ip: req.ip ?? null,
        user_agent: req.get('user-agent') ?? null,
      }).catch((err) => logger.warn({ err: err.message }, 'request-log write failed'));
    } catch (err) {
      logger.warn({ err: err.message }, 'request-log capture failed');
    }
  });

  next();
};
