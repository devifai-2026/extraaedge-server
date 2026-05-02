import { env } from '../../config/env.js';
import { logger } from '../logger.js';

const dummyMode = () => env.EXOTEL_API_KEY.startsWith('dummy_');

const basicAuth = () =>
  'Basic ' + Buffer.from(`${env.EXOTEL_API_KEY}:${env.EXOTEL_API_TOKEN}`).toString('base64');

// Bridge-call: Exotel rings the counsellor's mobile first, then the lead, then bridges them.
// `record=true` tells Exotel to record; on call end the StatusCallback webhook posts the recording URL.
export const clickToCall = async ({ counsellor_phone, lead_phone, status_callback_url, record = true, time_limit = 3600 }) => {
  if (dummyMode()) {
    logger.warn({ counsellor_phone, lead_phone }, 'Exotel dummy mode — skipping bridge call');
    return { provider: 'exotel', provider_call_id: `call_dummy_${Date.now()}`, status: 'queued' };
  }

  const url = `https://${env.EXOTEL_SUBDOMAIN}/v1/Accounts/${env.EXOTEL_ACCOUNT_SID}/Calls/connect`;
  const form = new URLSearchParams({
    From: counsellor_phone,
    To: lead_phone,
    CallerId: env.EXOTEL_CALLER_ID,
    Record: record ? 'true' : 'false',
    TimeLimit: String(time_limit),
    StatusCallback: status_callback_url,
    StatusCallbackEvents: 'terminal',
    StatusCallbackContentType: 'application/json',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exotel click-to-call failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return { provider: 'exotel', provider_call_id: data?.Call?.Sid, status: data?.Call?.Status ?? 'queued' };
};

export const fetchRecording = async (recording_url) => {
  // Exotel recordings are protected; fetch with basic auth.
  const res = await fetch(recording_url, { headers: { Authorization: basicAuth() } });
  if (!res.ok) throw new Error(`Recording fetch failed: ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
};

export const normalizeWebhook = (event) => ({
  provider_call_id: event.CallSid,
  direction: event.Direction === 'inbound' ? 'inbound' : 'outbound',
  status: (event.Status || event.CallStatus || '').toLowerCase() || 'completed',
  duration_seconds: Number(event.DialCallDuration || event.ConversationDuration || 0),
  recording_url: event.RecordingUrl,
  from: event.From,
  to: event.To,
  raw: event,
  occurred_at: event.EndTime ? new Date(event.EndTime) : new Date(),
});
