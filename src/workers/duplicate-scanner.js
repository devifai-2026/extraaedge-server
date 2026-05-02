import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { logger } from '../lib/logger.js';

// Nightly fuzzy-dup scanner — flags likely duplicates that weren't caught at insert.
const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const { id } of tenants) {
      const tenant = await resolveTenantById(id);
      if (!tenant) continue;
      // Exact phone/email matches not yet logged
      await tenantQuery(
        tenant,
        `INSERT INTO lead_duplicate_matches (lead_a_id, lead_b_id, match_on, confidence, status)
         SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'phone', 0.95, 'open'
           FROM leads a JOIN leads b ON a.phone = b.phone AND a.id < b.id
          WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL AND a.phone IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM lead_duplicate_matches m WHERE m.lead_a_id = LEAST(a.id, b.id) AND m.lead_b_id = GREATEST(a.id, b.id))
          LIMIT 2000`,
      );
      await tenantQuery(
        tenant,
        `INSERT INTO lead_duplicate_matches (lead_a_id, lead_b_id, match_on, confidence, status)
         SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'email', 0.9, 'open'
           FROM leads a JOIN leads b ON lower(a.email::text) = lower(b.email::text) AND a.id < b.id
          WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL AND a.email IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM lead_duplicate_matches m WHERE m.lead_a_id = LEAST(a.id, b.id) AND m.lead_b_id = GREATEST(a.id, b.id))
          LIMIT 2000`,
      );
    }
  } catch (err) {
    logger.error({ err: err.message }, 'duplicate-scanner tick failed');
  }
};
// Run once every 24h
setInterval(tick, 24 * 60 * 60_000);
setTimeout(tick, 60_000);
