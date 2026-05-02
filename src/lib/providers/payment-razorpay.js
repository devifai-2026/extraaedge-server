import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { safeEqual } from '../crypto.js';

const dummyMode = () => env.RAZORPAY_KEY_ID.startsWith('dummy_');
const basicAuth = () =>
  'Basic ' + Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');

export const createPaymentLink = async ({ amount, currency = 'INR', reference_id, description, customer, notify = { sms: true, email: true }, callback_url }) => {
  if (dummyMode()) {
    logger.warn({ reference_id, amount }, 'Razorpay dummy mode');
    return {
      provider: 'razorpay',
      provider_link_id: `plink_dummy_${Date.now()}`,
      short_url: `https://rzp.io/l/dummy-${reference_id}`,
      status: 'created',
    };
  }
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: basicAuth() },
    body: JSON.stringify({
      amount: Math.round(amount * 100),
      currency,
      accept_partial: false,
      reference_id,
      description,
      customer,
      notify,
      callback_url,
      callback_method: 'get',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Razorpay create link failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return { provider: 'razorpay', provider_link_id: data.id, short_url: data.short_url, status: data.status };
};

// Razorpay webhook signature is HMAC-SHA256(raw body) using the webhook secret, hex-encoded.
export const verifyWebhookSignature = ({ rawBody, receivedSignature }) => {
  if (!env.RAZORPAY_WEBHOOK_SECRET || env.RAZORPAY_WEBHOOK_SECRET.startsWith('dummy_')) return true;
  const expected = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return safeEqual(expected, receivedSignature);
};

export const normalizeWebhook = (event) => {
  const evt = event.event;
  const payment = event.payload?.payment?.entity;
  const link = event.payload?.payment_link?.entity;
  return {
    event_type: evt,
    provider_payment_id: payment?.id,
    provider_link_id: link?.id,
    amount: payment?.amount ? payment.amount / 100 : null,
    currency: payment?.currency,
    status: payment?.status,
    method: payment?.method,
    raw: event,
    occurred_at: new Date(event.created_at * 1000),
  };
};
