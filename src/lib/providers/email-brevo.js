import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { safeEqual, hmac } from '../crypto.js';

// Adapter for Brevo (formerly Sendinblue) transactional email.
// Swap-in-able: any provider that implements { sendEmail, verifyWebhook }.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

export const sendEmail = async ({ to, subject, html, text, tags, replyTo, cc, bcc, messageId }) => {
  const payload = {
    sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
    to: [{ email: to }],
    cc: (cc || []).map((e) => ({ email: e })),
    bcc: (bcc || []).map((e) => ({ email: e })),
    subject,
    htmlContent: html,
    textContent: text,
    tags,
    replyTo: replyTo ? { email: replyTo } : undefined,
    headers: messageId ? { 'Message-Id': messageId } : undefined,
  };

  if (env.BREVO_API_KEY.startsWith('dummy_')) {
    logger.warn({ to, subject }, 'Brevo dummy mode — skipping real send');
    return { provider: 'brevo', provider_message_id: `dummy-${Date.now()}`, status: 'sent' };
  }

  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': env.BREVO_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brevo send failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return { provider: 'brevo', provider_message_id: data.messageId, status: 'queued' };
};

export const verifyWebhookSignature = ({ rawBody, receivedSignature }) => {
  if (!env.BREVO_WEBHOOK_SECRET || env.BREVO_WEBHOOK_SECRET.startsWith('dummy_')) return true;
  const expected = hmac(env.BREVO_WEBHOOK_SECRET, rawBody);
  return safeEqual(expected, receivedSignature);
};

// Webhook event → normalized status
export const normalizeWebhookEvent = (event) => {
  const map = {
    delivered: 'delivered',
    hard_bounce: 'bounced',
    soft_bounce: 'failed',
    unique_opened: 'seen',
    opened: 'seen',
    click: 'clicked',
    unsubscribed: 'unsubscribed',
    complaint: 'bounced',
    deferred: 'queued',
    spam: 'bounced',
    invalid_email: 'bounced',
    blocked: 'failed',
  };
  return {
    provider_message_id: event['message-id'] || event.message_id,
    recipient: event.email,
    status: map[event.event] ?? 'failed',
    raw: event,
    occurred_at: event.date ? new Date(event.date) : new Date(),
  };
};
