// Email helpers for the LMS flows (student set-password / reset links).
//
// The actual transport already exists — src/lib/providers/email-brevo.js — and
// is used across the workers. We re-export its sendEmail here and add a small
// branded link-email HTML builder so LMS callers have one import. sendEmail
// THROWS on a hard failure (matching the provider); LMS callers wrap it and
// always keep a copy-link fallback, so email is never on the critical path.
import { sendEmail as brevoSend } from './providers/email-brevo.js';
import { logger } from './logger.js';

// Best-effort wrapper: returns { sent, id } and never throws, so LMS flows
// (course-confirm, reset) can fall back to the copyable link on any failure.
export const sendEmail = async ({ to, subject, html, text, replyTo } = {}) => {
  const recipient = typeof to === 'string' ? to : to?.email;
  if (!recipient || !subject || !html) return { sent: false, error: 'missing_fields' };
  try {
    const r = await brevoSend({ to: recipient, subject, html, text, replyTo });
    return { sent: true, id: r?.provider_message_id };
  } catch (err) {
    logger.error({ err: err.message, subject }, 'sendEmail failed (fallback available)');
    return { sent: false, error: err.message };
  }
};

// Minimal branded HTML shell for action-link emails (set-password, reset).
export const linkEmailHtml = ({ heading, intro, buttonLabel, url, footer }) => `
  <div style="font-family:'Segoe UI',system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a">
    <h2 style="font-size:18px;margin:0 0 12px">${heading}</h2>
    <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 20px">${intro}</p>
    <p style="margin:0 0 20px">
      <a href="${url}" style="display:inline-block;background:#E53935;color:#fff;text-decoration:none;
         padding:11px 22px;border-radius:8px;font-size:14px;font-weight:600">${buttonLabel}</a>
    </p>
    <p style="font-size:12px;color:#64748b;margin:0 0 6px">Or paste this link into your browser:</p>
    <p style="font-size:12px;color:#2563eb;word-break:break-all;margin:0 0 20px">${url}</p>
    ${footer ? `<p style="font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px">${footer}</p>` : ''}
  </div>`;
