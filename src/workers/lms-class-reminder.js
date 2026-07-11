// LMS class reminder — every minute, scan for classes starting in the next ~5
// minutes that haven't ended and haven't already been reminded, and push a
// "starting soon" notification to the batch's students. reminder_sent_at makes
// it fire once. Mirrors the followup-reminder-scheduler pattern (setInterval).
import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { notifyBatch } from '../modules/student-notifications/service.js';
import { logger } from '../lib/logger.js';

const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const { id } of tenants) {
      // eslint-disable-next-line no-await-in-loop
      const tenant = await resolveTenantById(id);
      if (!tenant) continue;
      // Classes starting within the next 6 minutes (small buffer over 5),
      // not started/ended, no reminder yet.
      // eslint-disable-next-line no-await-in-loop
      const { rows: soon } = await tenantQuery(
        tenant,
        `SELECT id, batch_id, title, starts_at
           FROM classes
          WHERE deleted_at IS NULL AND ended_at IS NULL AND started_at IS NULL
            AND reminder_sent_at IS NULL
            AND starts_at BETWEEN now() AND now() + interval '6 minutes'
          LIMIT 200`,
        [],
      );
      for (const c of soon) {
        // eslint-disable-next-line no-await-in-loop
        await notifyBatch(tenant, { batchId: c.batch_id }, {
          type: 'class_starting_soon',
          message: `Your class "${c.title}" starts in a few minutes — get ready!`,
          link: '/student/classes',
          metadata: { class_id: c.id },
        });
        // eslint-disable-next-line no-await-in-loop
        await tenantQuery(tenant, `UPDATE classes SET reminder_sent_at = now() WHERE id = $1`, [c.id]);
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'lms-class-reminder tick failed');
  }
};

setInterval(tick, 60_000);
setTimeout(tick, 8_000);
