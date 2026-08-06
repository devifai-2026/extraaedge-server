// One-off backfill: resolve lat/lng/city/country/isp for existing
// user_login_events rows that predate the geo columns, or that were
// resolved via the old geoip-lite lookup before the switch to ip-api.com
// (see lib/ipGeo.js for why — geoip-lite's free offline data was flat wrong
// for some reassigned ISP ranges). New rows resolve this at insert time
// (modules/auth/repo.js logLoginEvent) — this script re-resolves anything
// still missing an ISP, which covers both "never resolved" and "resolved
// by the old geoip-lite path".
//
//   node scripts/backfill-login-events-geo.js
//
// Rate-limited to ip-api.com's free-tier 45 req/min — resolves per DISTINCT
// ip (not per row) and applies the result to every row sharing that IP in
// one UPDATE, since office/home IPs repeat heavily across login history.
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { resolveIpGeo } from '../src/lib/ipGeo.js';
import { logger } from '../src/lib/logger.js';

const REQUEST_SPACING_MS = 1400; // ~43/min, under the 45/min free-tier cap
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const { rows: tenants } = await sysQuery(
    `SELECT id, slug, name, status, db_name, db_user, db_password_encrypted
       FROM tenants
      WHERE status = 'active' AND deleted_at IS NULL
      ORDER BY created_at`,
  );

  let distinctIps = 0;
  let rowsUpdated = 0;
  let noHit = 0;

  for (const tenant of tenants) {
    let ips;
    try {
      const r = await tenantQuery(
        tenant,
        `SELECT DISTINCT ip FROM user_login_events WHERE geo_isp IS NULL AND ip IS NOT NULL AND ip <> ''`,
      );
      ips = r.rows.map((row) => row.ip);
    } catch (err) {
      logger.error({ slug: tenant.slug, err: err.message }, 'geo backfill: could not read tenant login events');
      continue;
    }

    for (const ip of ips) {
      distinctIps += 1;
      const geo = await resolveIpGeo(ip);
      if (!geo) { noHit += 1; continue; }
      const { rowCount } = await tenantQuery(
        tenant,
        `UPDATE user_login_events
            SET lat = $2, lng = $3, geo_city = $4, geo_country = $5, geo_isp = $6, location_source = 'ip'
          WHERE ip = $1 AND geo_isp IS NULL`,
        [ip, geo.lat, geo.lng, geo.city, geo.country, geo.isp],
      );
      rowsUpdated += rowCount ?? 0;
      await sleep(REQUEST_SPACING_MS);
    }
  }

  logger.info({ tenants: tenants.length, distinctIps, rowsUpdated, noHit }, 'backfill-login-events-geo: done');

  await closeAllTenantPools();
  await closeSystemPool();
};

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'backfill-login-events-geo failed');
  process.exit(1);
});
