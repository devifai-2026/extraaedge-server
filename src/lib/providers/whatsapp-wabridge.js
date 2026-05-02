import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { safeEqual, hmac } from '../crypto.js';

// WABridge WhatsApp Business API wrapper.
const dummyMode = () => env.WABRIDGE_API_KEY.startsWith('dummy_');

export const sendTemplate = async ({ to, template_name, language, components }) => {
  if (dummyMode()) {
    logger.warn({ to, template_name }, 'WABridge dummy mode — skipping real send');
    return { provider: 'wabridge', provider_message_id: `dummy-${Date.now()}`, status: 'sent' };
  }
  const url = `${env.WABRIDGE_BASE_URL}/messages/template`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${env.WABRIDGE_API_KEY}`,
    },
    body: JSON.stringify({
      phone_number_id: env.WABRIDGE_PHONE_NUMBER_ID,
      to,
      template: { name: template_name, language: { code: language }, components },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WABridge send failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return { provider: 'wabridge', provider_message_id: data?.messages?.[0]?.id, status: 'queued' };
};

export const sendSessionMessage = async ({ to, body, media_url, media_type }) => {
  if (dummyMode()) {
    logger.warn({ to }, 'WABridge dummy session mode');
    return { provider: 'wabridge', provider_message_id: `dummy-${Date.now()}`, status: 'sent' };
  }
  const url = `${env.WABRIDGE_BASE_URL}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${env.WABRIDGE_API_KEY}`,
    },
    body: JSON.stringify({
      phone_number_id: env.WABRIDGE_PHONE_NUMBER_ID,
      to,
      type: media_url ? media_type : 'text',
      text: media_url ? undefined : { body },
      ...(media_url ? { [media_type]: { link: media_url, caption: body } } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WABridge session send failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return { provider: 'wabridge', provider_message_id: data?.messages?.[0]?.id, status: 'queued' };
};

export const verifyWebhookSignature = ({ rawBody, receivedSignature }) => {
  if (!env.WABRIDGE_WEBHOOK_SECRET || env.WABRIDGE_WEBHOOK_SECRET.startsWith('dummy_')) return true;
  const expected = hmac(env.WABRIDGE_WEBHOOK_SECRET, rawBody);
  return safeEqual(expected, receivedSignature);
};

export const normalizeStatus = (event) => {
  const map = {
    sent: 'sent',
    delivered: 'delivered',
    read: 'seen',
    failed: 'failed',
  };
  return {
    provider_message_id: event.id,
    recipient: event.recipient_id ?? event.to,
    status: map[event.status] ?? 'failed',
    raw: event,
    occurred_at: event.timestamp ? new Date(Number(event.timestamp) * 1000) : new Date(),
  };
};

export const normalizeInbound = (event) => ({
  from: event.from,
  body: event.text?.body,
  media_type: event.type,
  media_id: event.image?.id ?? event.document?.id ?? event.audio?.id,
  occurred_at: event.timestamp ? new Date(Number(event.timestamp) * 1000) : new Date(),
  raw: event,
});
