// Per-tenant WABridge client. Unlike lib/providers/whatsapp-wabridge.js (which
// reads global env for the OTP flow), this takes each tenant's OWN credentials
// so every institute sends from its own WhatsApp Business number.
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { logWaWebhook } from './webhook-log.js';

const normalizeNumber = (raw) => {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 10 ? `91${d}` : d;
};

const requireCreds = (creds) => {
  if (!creds?.appKey || !creds?.authKey || !creds?.deviceId) {
    const err = new Error('WhatsApp not configured for this tenant. Add WABridge keys in Settings → WhatsApp.');
    err.code = 'WA_NOT_CONFIGURED';
    throw err;
  }
};

const baseBody = (creds) => ({
  'app-key': creds.appKey,
  'auth-key': creds.authKey,
  device_id: creds.deviceId,
});

// `log` (optional) = { tenant, event, phone } → persists the raw request +
// response for the PO console Webhooks tab. Credentials are redacted from the
// stored request so app/auth keys never land in the log table.
const post = async (path, body, log = null) => {
  const res = await fetch(`${env.WABRIDGE_BASE_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (log?.tenant) {
    const redacted = { ...body };
    delete redacted['app-key']; delete redacted['auth-key']; delete redacted.device_id;
    logWaWebhook(log.tenant, {
      direction: 'outbound', event: log.event || path, endpoint: path, phone: log.phone || null,
      statusCode: res.status, ok: !!data?.status, request: redacted, response: data,
      error: data?.status ? null : (data?.message || null),
    }).catch(() => {});
  }
  return data;
};

// Free text (24h customer-service window only).
export const sendText = async (creds, { to, message, tenant = null }) => {
  requireCreds(creds);
  const destination = normalizeNumber(to);
  if (!destination) throw new Error('Invalid destination number');
  const data = await post('createtextmessage', { ...baseBody(creds), destination_number: destination, message, media_link: '', media_type: '' }, { tenant, event: 'send_text', phone: destination });
  if (!data?.status) {
    logger.warn({ body: data }, 'WABridge text send failed');
    const err = new Error(data?.message || 'WABridge text send failed');
    err.code = 'WABRIDGE_SEND_FAILED';
    throw err;
  }
  return { messageId: data?.data?.messageid || '' };
};

// Pre-approved template (positional variables → {{1}},{{2}}…).
export const sendTemplate = async (creds, { to, templateId, variables = [], tenant = null }) => {
  requireCreds(creds);
  if (!templateId) throw new Error('templateId is required');
  const destination = normalizeNumber(to);
  if (!destination) throw new Error('Invalid destination number');
  const data = await post('createmessage', {
    ...baseBody(creds), destination_number: destination, template_id: templateId,
    variables, button_variable: [], media: '', message: '',
  }, { tenant, event: 'send_template', phone: destination });
  if (!data?.status) {
    const err = new Error(data?.message || 'WABridge template send failed');
    err.code = 'WABRIDGE_SEND_FAILED';
    throw err;
  }
  return { messageId: data?.data?.messageid || '' };
};

// Approved templates for the composer picker.
export const listTemplates = async (creds, { limit = 100 } = {}) => {
  requireCreds(creds);
  const data = await post('gettemplate', { ...baseBody(creds), limit });
  if (!data?.status) throw new Error(data?.message || 'WABridge template list failed');
  return (data.data || []).map((t) => {
    const b = (t.components || []).find((c) => c.type === 'BODY');
    const text = b?.text || '';
    return {
      id: t.id, name: t.name, language: t.language, category: t.category, status: t.status,
      bodyText: text, variableCount: (text.match(/\{\{\d+\}\}/g) || []).length,
    };
  });
};
