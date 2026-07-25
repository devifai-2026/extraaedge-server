// Shared lead-audience resolver for marketing (bulk campaigns, drip, remarketing
// audiences, campaign preview). One place so every surface filters leads the
// same way. Reads a plain JSON filter and returns a WHERE fragment + params
// over the `leads l` table.
//
// Supported filter keys (all optional, ANDed together):
//   stage_ids      uuid[]  — l.stage_id = ANY
//   program_ids    uuid[]  — l.program_id = ANY
//   assigned_to    uuid[]  — l.assigned_to = ANY
//   sources        text[]  — l.first_touch_source ILIKE ANY (e.g. ['Facebook'])
//   channels       text[]  — l.first_touch_channel ILIKE ANY
//   created_from   date    — l.created_at >= (inclusive)
//   created_to     date    — l.created_at <= end-of-day (inclusive)
//   tag_ids        uuid[]  — EXISTS a lead_tags row for the lead with tag_id ANY
//
// Always excludes soft-deleted leads. `startIdx` lets callers place params after
// their own bind slots.
export const buildAudienceWhere = (filter = {}, startIdx = 1) => {
  const conds = ['l.deleted_at IS NULL'];
  const params = [];
  let i = startIdx;
  const push = (v) => { params.push(v); return `$${i++}`; };

  if (Array.isArray(filter.stage_ids) && filter.stage_ids.length) {
    conds.push(`l.stage_id = ANY(${push(filter.stage_ids)}::uuid[])`);
  }
  if (Array.isArray(filter.program_ids) && filter.program_ids.length) {
    conds.push(`l.program_id = ANY(${push(filter.program_ids)}::uuid[])`);
  }
  if (Array.isArray(filter.assigned_to) && filter.assigned_to.length) {
    conds.push(`l.assigned_to = ANY(${push(filter.assigned_to)}::uuid[])`);
  }
  if (Array.isArray(filter.sources) && filter.sources.length) {
    conds.push(`l.first_touch_source ILIKE ANY(${push(filter.sources)}::text[])`);
  }
  if (Array.isArray(filter.channels) && filter.channels.length) {
    conds.push(`l.first_touch_channel ILIKE ANY(${push(filter.channels)}::text[])`);
  }
  if (filter.created_from) {
    conds.push(`l.created_at >= ${push(filter.created_from)}::date`);
  }
  if (filter.created_to) {
    // inclusive end-of-day
    conds.push(`l.created_at < (${push(filter.created_to)}::date + INTERVAL '1 day')`);
  }
  if (Array.isArray(filter.tag_ids) && filter.tag_ids.length) {
    conds.push(`EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id AND lt.tag_id = ANY(${push(filter.tag_ids)}::uuid[]))`);
  }

  return { where: conds.join(' AND '), params, nextIdx: i };
};

// Convenience: resolve the matching leads (id + contact fields) for a filter.
export const resolveAudienceLeads = async (tenantQuery, tenant, filter = {}) => {
  const { where, params } = buildAudienceWhere(filter, 1);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT l.id, l.email, l.phone, l.whatsapp_number, l.name, l.assigned_to
       FROM leads l WHERE ${where}`,
    params,
  );
  return rows;
};

// Convenience: count matching leads (for the preview endpoint).
export const countAudience = async (tenantQuery, tenant, filter = {}) => {
  const { where, params } = buildAudienceWhere(filter, 1);
  const { rows } = await tenantQuery(tenant, `SELECT count(*)::int AS n FROM leads l WHERE ${where}`, params);
  return rows[0]?.n ?? 0;
};
