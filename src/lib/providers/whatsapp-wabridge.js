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
