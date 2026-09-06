// Lead-origin classification — the single definition of "which channel did
// this lead come in through", shared by the leads filter, the analytics
// buckets and the source-based routing pools (modules/lead-routing).
//
// Origin is DERIVED, not stored: intake paths stamp free text onto
// leads.first_touch_channel / first_touch_source at createLead time
// (whatsapp-inbox writes 'whatsapp', the Meta bridge writes 'Facebook Lead
// Ads' / 'Instagram', public-leads writes channel 'Website' with the domain
// as the source), and everything downstream matches against those two
// columns. Keep this in sync with extraaedge-admin/src/lib/leadOrigin.js.
//
// ORDER MATTERS: instagram is tested before facebook. Meta delivers Instagram
// lead ads on the same leadgen webhook as Facebook, so an Instagram lead can
// carry a facebook-ish source alongside channel='Instagram' — the more
// specific match has to win.
export const LEAD_ORIGINS = Object.freeze(['whatsapp', 'instagram', 'facebook', 'justdial', 'website']);

// Substring each origin looks for. `whatsapp` is an exact match on purpose:
// a lead whose source merely mentions whatsapp (a campaign name, say) is not
// a WhatsApp-inbox lead.
const MATCHERS = Object.freeze({
  whatsapp: { exact: true, needle: 'whatsapp', fields: ['source', 'channel'] },
  instagram: { exact: false, needle: 'instagram', fields: ['source', 'channel'] },
  facebook: { exact: false, needle: 'facebook', fields: ['source', 'channel'] },
  justdial: { exact: false, needle: 'justdial', fields: ['source', 'channel'] },
  // Website leads carry the submitting domain in first_touch_source, so only
  // the channel is a reliable signal.
  website: { exact: false, needle: 'website', fields: ['channel'] },
});

const norm = (v) => String(v ?? '').toLowerCase();

const hit = (lead, origin) => {
  const m = MATCHERS[origin];
  if (!m) return false;
  return m.fields.some((f) => {
    const v = norm(f === 'source' ? lead?.first_touch_source : lead?.first_touch_channel);
    return m.exact ? v === m.needle : v.includes(m.needle);
  });
};

// Returns the lead's origin, or null for a plain manual / bulk-import lead
// with no notable acquisition channel.
export const classifyOrigin = (lead) => {
  if (!lead) return null;
  return LEAD_ORIGINS.find((o) => hit(lead, o)) ?? null;
};

// SQL predicate for one origin, for use in a WHERE clause. `alias` is the
// leads table alias in the caller's query; pass '' (or null) for an unaliased
// `FROM leads`. Returns null for an unknown origin so callers can skip the
// clause rather than emit broken SQL.
//
// The interpolated pattern comes from this module's own MATCHERS table, never
// from caller input — there is nothing user-controlled to escape here.
//
// NOTE: unlike classifyOrigin this is a plain per-origin match, NOT
// first-match-wins — so filtering by 'facebook' also returns Instagram leads
// that mention facebook. That matches the pre-existing filter behaviour.
export const originSqlPredicate = (origin, alias = 'l') => {
  const m = MATCHERS[origin];
  if (!m) return null;
  const pattern = m.exact ? m.needle : `%${m.needle}%`;
  const prefix = alias ? `${alias}.` : '';
  const parts = m.fields.map((f) => {
    const col = f === 'source' ? 'first_touch_source' : 'first_touch_channel';
    return `${prefix}${col} ILIKE '${pattern}'`;
  });
  return `(${parts.join(' OR ')})`;
};
