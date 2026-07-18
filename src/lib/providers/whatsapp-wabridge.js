// WABridge WhatsApp sender — used to deliver the phone-change OTP on the web
// profile page. Mirrors the request shape proven in rg-phase-2/productivo:
// POST {WABRIDGE_BASE_URL}/createmessage with app-key/auth-key/device_id in the
// BODY (not headers), a numeric template_id, and a flat positional `variables`
// array (variables[0] -> {{1}}, variables[1] -> {{2}}). Template name/language
// are configured on the WABridge side and resolved by the id.
import { env } from '../../config/env.js';
import { logger } from '../logger.js';

const isConfigured = () =>
  Boolean(env.WABRIDGE_APP_KEY && env.WABRIDGE_AUTH_KEY && env.WABRIDGE_DEVICE_ID);

// WABridge expects 91 + last-10 digits for Indian numbers.
const normalizeNumber = (raw) => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `91${digits}` : digits;
};

// Send a template message. `variables` is positional: [ {{1}}, {{2}}, ... ].
// Returns { messageId }. Throws if not configured or the API reports failure.
export const sendTemplate = async ({ to, templateId, variables = [] }) => {
  if (!isConfigured()) {
    throw new Error('WABridge not configured (set WABRIDGE_APP_KEY / WABRIDGE_AUTH_KEY / WABRIDGE_DEVICE_ID)');
  }
  if (!templateId) throw new Error('WABridge templateId is required');
  const destination = normalizeNumber(to);
  if (!destination) throw new Error('Invalid destination number');

  const payload = {
    'app-key': env.WABRIDGE_APP_KEY,
    'auth-key': env.WABRIDGE_AUTH_KEY,
    destination_number: destination,
    device_id: env.WABRIDGE_DEVICE_ID,
    template_id: templateId,
    variables,
    button_variable: [],
    media: '',
    message: '',
  };

  const res = await fetch(`${env.WABRIDGE_BASE_URL}/createmessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!data?.status) {
    logger.warn({ status: res.status, body: data }, 'WABridge template send failed');
    throw new Error(data?.message || 'WABridge template send failed');
  }
  return { messageId: data?.data?.messageid || '' };
};

// Send the phone-change OTP using the speedup_template
// ("Here is Your {{1}} for speedup crm *{{2}}* *Speedup Team*"):
//   {{1}} = "OTP", {{2}} = the code.
export const sendPhoneOtp = async ({ to, code }) =>
  sendTemplate({ to, templateId: env.WABRIDGE_TEMPLATE_OTP, variables: ['OTP', code] });

// ── Free-text send (WhatsApp inbox) ──
// POST {BASE}/createtextmessage. Free-text only delivers inside WhatsApp's 24h
// customer-service window; outside it WABridge errors and a template is required.
// `mediaLink`/`mediaType` optionally attach media by public URL.
export const sendText = async ({ to, message, mediaLink = '', mediaType = '' }) => {
  if (!isConfigured()) {
    throw new Error('WABridge not configured (set WABRIDGE_APP_KEY / WABRIDGE_AUTH_KEY / WABRIDGE_DEVICE_ID)');
  }
  if (!message) throw new Error('message is required');
  const destination = normalizeNumber(to);
  if (!destination) throw new Error('Invalid destination number');

  const payload = {
    'app-key': env.WABRIDGE_APP_KEY,
    'auth-key': env.WABRIDGE_AUTH_KEY,
    destination_number: destination,
    device_id: env.WABRIDGE_DEVICE_ID,
    message,
    media_link: mediaLink,
    media_type: mediaType,
  };

  const res = await fetch(`${env.WABRIDGE_BASE_URL}/createtextmessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!data?.status) {
    logger.warn({ status: res.status, body: data }, 'WABridge text send failed');
    const err = new Error(data?.message || 'WABridge text send failed');
    err.code = 'WABRIDGE_SEND_FAILED';
    throw err;
  }
  return { messageId: data?.data?.messageid || '' };
};

// List WABridge templates, normalized for the composer's template picker.
// Only APPROVED templates are messageable; caller filters.
export const listTemplates = async ({ limit = 100 } = {}) => {
  if (!isConfigured()) {
    throw new Error('WABridge not configured (set WABRIDGE_APP_KEY / WABRIDGE_AUTH_KEY / WABRIDGE_DEVICE_ID)');
  }
  const payload = {
    'app-key': env.WABRIDGE_APP_KEY,
    'auth-key': env.WABRIDGE_AUTH_KEY,
    device_id: env.WABRIDGE_DEVICE_ID,
    limit,
  };
  const res = await fetch(`${env.WABRIDGE_BASE_URL}/gettemplate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!data?.status) {
    throw new Error(data?.message || 'WABridge template list failed');
  }
  return (data.data || []).map((t) => {
    const body = (t.components || []).find((c) => c.type === 'BODY');
    const text = body?.text || '';
    const variableCount = (text.match(/\{\{\d+\}\}/g) || []).length;
    return {
      id: t.id,
      name: t.name,
      language: t.language,
      category: t.category,
      status: t.status,
      bodyText: text,
      variableCount,
    };
  });
};
