// Weekly email to each tenant's super_admins summarizing the same anomalies
// GET /analytics/security-anomalies shows on demand (see lib/securityAnomalies.js
// for what each check means) — turns passive audit data into a habit instead
// of something someone has to remember to go look at.
//
// No new schema for "when did we last send this tenant's digest" — an
// in-memory Map keyed by tenant id is enough: a process restart mid-week
// just means the next matching hour re-sends (acceptable for a weekly digest,
// not worth a persisted column for). Ticks hourly and only actually sends in
// the one matching UTC day+hour per tenant, so this is cheap the other 167
// hours of the week.
import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { computeSecurityAnomalies } from '../lib/securityAnomalies.js';
import { sendEmail } from '../lib/providers/email-brevo.js';
import { logger } from '../lib/logger.js';

const DIGEST_DAY = 1; // Monday (UTC)
const DIGEST_HOUR = 8; // 08:00 UTC
const RESEND_GUARD_MS = 20 * 60 * 60 * 1000; // don't double-send within the same day

const lastSentAt = new Map();

const isDigestWindow = (tenantId) => {
  const now = new Date();
  if (now.getUTCDay() !== DIGEST_DAY || now.getUTCHours() !== DIGEST_HOUR) return false;
  const last = lastSentAt.get(tenantId);
  return !last || (now.getTime() - last.getTime()) > RESEND_GUARD_MS;
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const buildDigestHtml = (tenant, anomalies) => {
  const section = (title, rows, renderRow) => {
    if (!rows.length) return '';
    return `<h3 style="margin:16px 0 4px">${title} (${rows.length})</h3><ul>${rows.map((r) => `<li>${renderRow(r)}</li>`).join('')}</ul>`;
  };
  const body = [
    section('Concurrent sessions', anomalies.concurrent_sessions, (r) =>
      `${escapeHtml(r.user_name)} (${escapeHtml(r.user_role)}) — ${r.active_sessions} active sessions from ${r.distinct_ips} IPs: ${escapeHtml((r.ips || []).join(', '))}`),
    section('New devices', anomalies.new_devices, (r) =>
      `${escapeHtml(r.user_name)} (${escapeHtml(r.user_role)}) — first time seen from this browser, ${new Date(r.issued_at).toLocaleString()}`),
    section('Unusual login locations', anomalies.location_anomalies, (r) =>
      `${escapeHtml(r.user_name)} (${escapeHtml(r.user_role)}) — logged in from ${escapeHtml(r.geo_city || '')}${r.geo_city ? ', ' : ''}${escapeHtml(r.geo_country)}, usually ${escapeHtml(r.usual_country)}`),
  ].join('');
  return `<div style="font-family:sans-serif;color:#222">
    <h2>Weekly security digest — ${escapeHtml(tenant.name)}</h2>
    <p style="color:#666">Heuristic flags for review, not proof of wrongdoing.</p>
    ${body || '<p>Nothing flagged this week.</p>'}
  </div>`;
};

const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const { id } of tenants) {
      if (!isDigestWindow(id)) continue;
      try {
        const tenant = await resolveTenantById(id);
        if (!tenant) continue;
        const anomalies = await computeSecurityAnomalies(tenant);
        const total = anomalies.concurrent_sessions.length + anomalies.new_devices.length + anomalies.location_anomalies.length;
        if (total === 0) { lastSentAt.set(id, new Date()); continue; }

        const { rows: admins } = await tenantQuery(
          tenant,
          `SELECT email FROM users WHERE role = 'super_admin' AND is_active = true AND deleted_at IS NULL AND email IS NOT NULL`,
        );
        const html = buildDigestHtml(tenant, anomalies);
        for (const admin of admins) {
          await sendEmail({
            to: admin.email,
            subject: `Weekly security digest — ${total} item${total === 1 ? '' : 's'} to review`,
            html,
            text: html.replace(/<[^>]+>/g, ' '),
          }).catch((err) => logger.error({ err: err.message, tenant: tenant.slug, to: admin.email }, 'security-digest send failed'));
        }
        lastSentAt.set(id, new Date());
      } catch (err) {
        logger.error({ tenantId: id, err: err.message }, 'security-digest-mailer failed for tenant');
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'security-digest-mailer failed');
  }
};

setInterval(tick, 60 * 60_000);
setTimeout(tick, 45_000);
