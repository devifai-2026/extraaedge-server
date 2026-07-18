// Meta WhatsApp Cloud API client — used ONLY for the inbound side:
//   - downloadMedia(mediaId): fetch a media object the customer sent us
//   - markRead(waMessageId): send a read receipt back so the customer sees ✓✓
// Outbound sending is handled by WABridge (lib/providers/whatsapp-wabridge.js);
// this file never sends chat messages.
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';

const graphBase = () => `https://graph.facebook.com/${env.WA_API_VERSION}`;
const isConfigured = () => Boolean(env.WA_ACCESS_TOKEN && env.WA_PHONE_NUMBER_ID);

// Two-step Meta media fetch: GET /{mediaId} → { url }, then GET that url with
// the bearer token to download the bytes. Returns { buffer, mimeType } or null.
export const downloadMedia = async (mediaId) => {
  if (!mediaId || !env.WA_ACCESS_TOKEN) return null;
  try {
    const metaRes = await fetch(`${graphBase()}/${mediaId}`, {
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    });
    if (!metaRes.ok) throw new Error(`media meta ${metaRes.status}`);
    const meta = await metaRes.json();
    if (!meta?.url) return null;

    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    });
    if (!binRes.ok) throw new Error(`media download ${binRes.status}`);
    const arrayBuf = await binRes.arrayBuffer();
    return { buffer: Buffer.from(arrayBuf), mimeType: meta.mime_type || 'application/octet-stream' };
  } catch (err) {
    logger.warn({ mediaId, err: err.message }, 'wa meta downloadMedia failed');
    return null;
  }
};

// Best-effort read receipt back to Meta (shows the customer their message was
// read). Never throws.
export const markRead = async (waMessageId) => {
  if (!waMessageId || !isConfigured()) return;
  try {
    await fetch(`${graphBase()}/${env.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: waMessageId }),
    });
  } catch (err) {
    logger.debug({ waMessageId, err: err.message }, 'wa meta markRead failed');
  }
};
