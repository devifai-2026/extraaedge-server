// One-off backfill: resolve lat/lng/city/country for existing
// user_login_events rows that predate the geo columns (migration
// 1700000121000_login_events_geo). New rows resolve this at insert time
// (see modules/auth/repo.js logLoginEvent) — this script only needs to run
// once, after that migration lands, across every active tenant.
//
//   node scripts/backfill-login-events-geo.js
import 'dotenv/config';
import geoip from 'geoip-lite';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { logger } from '../src/lib/logger.js';

const resolveIpGeo = (ip) => {
  if (!ip) return null;
  try {
    const hit = geoip.lookup(ip);
    if (!hit) return null;
    const [lat, lng] = hit.ll || [];
    return { lat: lat ?? null, lng: lng ?? null, city: hit.city || null, country: hit.country || null };
  } catch {
    return null;
  }
};

const main = async () => {
  const { rows: tenants } = await sysQuery(
    `SELECT id, slug, name, status, db_name, db_user, db_password_encrypted
       FROM tenants
      WHERE status = 'active' AND deleted_at IS NULL
      ORDER BY created_at`,
  );

  let scanned = 0;
  let updated = 0;
  let noHit = 0;

  for (const tenant of tenants) {
    let rows;
    try {
      const r = await tenantQuery(
        tenant,
        `SELECT id, ip FROM user_login_events WHERE lat IS NULL AND ip IS NOT NULL AND ip <> ''`,
      );
      rows = r.rows;
    } catch (err) {
      logger.error({ slug: tenant.slug, err: err.message }, 'geo backfill: could not read tenant login events');
      continue;
    }

    for (const row of rows) {
      scanned += 1;
      const geo = resolveIpGeo(row.ip);
      if (!geo) { noHit += 1; continue; }
      await tenantQuery(
        tenant,
        `UPDATE user_login_events
            SET lat = $2, lng = $3, geo_city = $4, geo_country = $5, location_source = 'ip'
          WHERE id = $1`,
        [row.id, geo.lat, geo.lng, geo.city, geo.country],
      );
      updated += 1;
    }
  }

  logger.info({ tenants: tenants.length, scanned, updated, noHit }, 'backfill-login-events-geo: done');

  await closeAllTenantPools();
  await closeSystemPool();
};

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'backfill-login-events-geo failed');
  process.exit(1);
});
