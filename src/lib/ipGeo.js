import geoip from 'geoip-lite';
import { logger } from './logger.js';

// ip-api.com's free endpoint: no key, no signup, 45 req/min per calling IP,
// continuously-updated commercial-grade data — noticeably more accurate than
// geoip-lite's free offline snapshot (which is bundled once and goes stale,
// and is flat wrong for some reassigned ISP ranges — see the Pune/Nagpur
// mismatch that prompted this). HTTP only on the free tier, which is fine
// server-to-server. Falls back to the offline geoip-lite lookup if the
// network call fails or times out, so a login is never blocked or left with
// zero location data over a flaky outbound request.
const CACHE_TTL_MS = 60 * 60_000; // repeat office/home IPs shouldn't re-hit the API every login
const cache = new Map(); // ip -> { at, geo }

// geoip-lite has no ISP data at all — isp stays null on this fallback path.
const fromGeoipLite = (ip) => {
  try {
    const hit = geoip.lookup(ip);
    if (!hit) return null;
    const [lat, lng] = hit.ll || [];
    return { lat: lat ?? null, lng: lng ?? null, city: hit.city || null, country: hit.country || null, isp: null };
  } catch {
    return null;
  }
};

const fromIpApi = async (ip) => {
  // countryCode (2-letter, "IN"), not country ("India") — geoip-lite and
  // every row already backfilled use the 2-letter code. Mixing formats
  // would make the security-anomalies location check (which compares
  // geo_country values for equality) flag a false "unusual location" for
  // every single user the first time their country came from this source.
  const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,city,lat,lon,isp`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`ip-api.com HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(`ip-api.com: ${data.message || 'lookup failed'}`);
  return {
    lat: data.lat ?? null, lng: data.lon ?? null,
    city: data.city || null, country: data.countryCode || null, isp: data.isp || null,
  };
};

export const resolveIpGeo = async (ip) => {
  if (!ip) return null;
  const cached = cache.get(ip);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.geo;

  let geo = null;
  try {
    geo = await fromIpApi(ip);
  } catch (err) {
    logger.warn({ ip, err: err.message }, 'ip-api.com lookup failed, falling back to geoip-lite');
    geo = fromGeoipLite(ip);
  }
  cache.set(ip, { at: Date.now(), geo });
  return geo;
};
