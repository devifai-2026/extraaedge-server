import { env } from '../../config/env.js';
import { logger } from '../logger.js';

// MessageCentral Transactional SMS + OTP adapter.
// https://www.messagecentral.com — actual API paths TBC; swap to real endpoints when account is live.

const MC_BASE = 'https://cpaas.messagecentral.com';

const dummyMode = () => env.MESSAGECENTRAL_AUTH_TOKEN.startsWith('dummy_');

export const sendSms = async ({ to, body, dlt_template_id, dlt_entity_id }) => {
  if (dummyMode()) {
    logger.warn({ to, body: body?.slice(0, 40) }, 'MessageCentral dummy mode — skipping real send');
    return { provider: 'messagecentral', provider_message_id: `dummy-${Date.now()}`, status: 'sent' };
  }

  const url = `${MC_BASE}/verification/v3/send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authToken: env.MESSAGECENTRAL_AUTH_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      customerId: env.MESSAGECENTRAL_CUSTOMER_ID,
      senderId: env.MESSAGECENTRAL_SENDER_ID,
      mobileNumber: to,
      countryCode: env.MESSAGECENTRAL_COUNTRY_CODE,
      message: body,
      templateId: dlt_template_id,
      entityId: dlt_entity_id,
      type: 'SMS',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MessageCentral send failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return { provider: 'messagecentral', provider_message_id: data.verificationId ?? data.messageId, status: 'queued' };
};

export const sendOtp = async ({ to }) => {
  if (dummyMode()) {
    logger.warn({ to }, 'MessageCentral dummy OTP — returning dummy verification id');
    return { verification_id: `otp-dummy-${Date.now()}`, dummy: true };
  }
  const url = `${MC_BASE}/verification/v3/send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authToken: env.MESSAGECENTRAL_AUTH_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      customerId: env.MESSAGECENTRAL_CUSTOMER_ID,
      mobileNumber: to,
      countryCode: env.MESSAGECENTRAL_COUNTRY_CODE,
      type: 'OTP',
      flowType: 'SMS',
      otpLength: 6,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MessageCentral OTP send failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return { verification_id: data.verificationId, dummy: false };
};

export const verifyOtp = async ({ verification_id, code }) => {
  if (dummyMode()) {
    // in dev, accept any 6-digit code
    return { verified: /^\d{6}$/.test(code), dummy: true };
  }
  const url = `${MC_BASE}/verification/v3/validateOtp?verificationId=${encodeURIComponent(verification_id)}&code=${encodeURIComponent(code)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { authToken: env.MESSAGECENTRAL_AUTH_TOKEN },
  });
  if (!res.ok) return { verified: false };
  const data = await res.json();
  return { verified: data?.data?.verificationStatus === 'VERIFICATION_COMPLETED', raw: data };
};

export const normalizeDlrEvent = (event) => ({
  provider_message_id: event.messageId ?? event.verificationId,
  recipient: event.mobileNumber,
  status: event.status === 'DELIVERED' ? 'delivered' : event.status === 'FAILED' ? 'failed' : 'sent',
  raw: event,
  occurred_at: event.timestamp ? new Date(event.timestamp) : new Date(),
});
