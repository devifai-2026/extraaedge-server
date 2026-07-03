import { tenantQuery } from '../../db/tenant.js';
import { last10Digits } from '../../lib/phone.js';

// Tenant-wide, read-only Lead Pool lookup.
//
// Unlike modules/leads (which scopes rows to the actor's owner/team/branch),
// the Lead Pool intentionally searches EVERY lead in the tenant so a
// counsellor can answer "who owns this number / name?" without a reassign.
// The trade-off is that it returns only a small read-only projection — no
// notes, custom values, follow-ups or edit surface.
//
// Matching:
//   • name  → case-insensitive substring (ILIKE %q%).
//   • phone → the LAST 10 DIGITS of the query matched against the last-10
//     digits of phone / whatsapp_number / alternate_contact. This makes
//     "919876543210", "+91 98765-43210" and "9876543210" all collide, so a
//     91-prefixed number matches a lead stored without the prefix and vice
//     versa (mirrors modules/leads/repo.js dedup + the unique-phone guard).
//
// A query that is all digits (>= 6 of them) is treated as a phone search AND
// a name search (some tenants store numbers in the name field); a query with
// letters is a name search only. Callers get whichever rows match either arm.

const isPhoneish = (q) => last10Digits(q).length >= 6;

export const search = async (tenant, { q, limit = 25 }) => {
  const term = String(q ?? '').trim();
  if (!term) return [];

  const conds = [];
  const params = [];

  // Name arm — always attempted (cheap ILIKE).
  params.push(`%${term}%`);
  conds.push(`l.name ILIKE $${params.length}`);

  // Phone arm — only when the query carries enough digits to be a real
  // number. Match the incoming last-10 against the stored last-10 of each
  // phone-bearing column so prefix differences (91 / +91 / spaces) collide.
  if (isPhoneish(term)) {
    const d = last10Digits(term);
    params.push(d);
    const idx = params.length;
    for (const col of ['l.phone', 'l.whatsapp_number', 'l.alternate_contact']) {
      // Match on the last-10 digits when we have a full 10, otherwise fall
      // back to a substring-on-digits match so partial numbers still find
      // something useful.
      if (d.length === 10) {
        conds.push(`right(regexp_replace(coalesce(${col},''), '\\D', '', 'g'), 10) = $${idx}`);
      } else {
        conds.push(`regexp_replace(coalesce(${col},''), '\\D', '', 'g') LIKE '%' || $${idx} || '%'`);
      }
    }
  }

  params.push(Math.min(Math.max(Number(limit) || 25, 1), 100));
  const limitIdx = params.length;

  const { rows } = await tenantQuery(
    tenant,
    `SELECT
        l.id, l.name, l.email, l.phone, l.whatsapp_number, l.alternate_contact,
        l.stage_id, l.sub_stage_id, l.program_id, l.branch_id,
        l.created_at, l.updated_at, l.last_activity_at, l.converted_at,
        st.name  AS stage_name,
        sst.name AS sub_stage_name,
        p.name   AS program_name,
        br.name  AS branch_name,
        -- Current owner (leads.assigned_to snapshot).
        l.assigned_to,
        owner.name  AS assigned_to_name,
        owner.email AS assigned_to_email,
        owner.phone AS assigned_to_phone,
        -- Manager snapshot on the lead.
        l.manager_id,
        mgr.name  AS manager_name,
        mgr.email AS manager_email,
        -- Previous owner: most-recent CLOSED assignment row that had a
        -- from_user_id (i.e. the person the lead was moved AWAY from). Null
        -- when the lead has only ever had one owner.
        prev.from_user_id       AS previous_owner_id,
        prev_u.name             AS previous_owner_name,
        prev_u.email            AS previous_owner_email,
        prev.created_at         AS reassigned_at
      FROM leads l
      LEFT JOIN lead_stages     st  ON st.id  = l.stage_id
      LEFT JOIN lead_sub_stages sst ON sst.id = l.sub_stage_id
      LEFT JOIN programs        p   ON p.id   = l.program_id
      LEFT JOIN branches        br  ON br.id  = l.branch_id
      LEFT JOIN users           owner ON owner.id = l.assigned_to
      LEFT JOIN users           mgr   ON mgr.id   = l.manager_id
      LEFT JOIN LATERAL (
        SELECT la.from_user_id, la.created_at
          FROM lead_assignments la
         WHERE la.lead_id = l.id
           AND la.from_user_id IS NOT NULL
         ORDER BY la.created_at DESC
         LIMIT 1
      ) prev ON true
      LEFT JOIN users prev_u ON prev_u.id = prev.from_user_id
     WHERE l.deleted_at IS NULL
       AND (${conds.join(' OR ')})
     ORDER BY l.last_activity_at DESC NULLS LAST, l.created_at DESC
     LIMIT $${limitIdx}`,
    params,
  );

  return rows;
};

// Single lead read-only detail for the Lead Pool. Same tenant-wide (unscoped)
// projection as search() but for one id — used when the FE opens a row.
export const getOne = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT
        l.id, l.name, l.email, l.phone, l.whatsapp_number, l.alternate_contact,
        l.gender, l.city, l.district,
        l.stage_id, l.sub_stage_id, l.program_id, l.branch_id,
        l.created_at, l.updated_at, l.last_activity_at, l.converted_at,
        st.name  AS stage_name,
        sst.name AS sub_stage_name,
        p.name   AS program_name,
        br.name  AS branch_name,
        l.assigned_to,
        owner.name  AS assigned_to_name,
        owner.email AS assigned_to_email,
        owner.phone AS assigned_to_phone,
        l.manager_id,
        mgr.name  AS manager_name,
        mgr.email AS manager_email,
        prev.from_user_id AS previous_owner_id,
        prev_u.name       AS previous_owner_name,
        prev_u.email      AS previous_owner_email,
        prev.created_at   AS reassigned_at
      FROM leads l
      LEFT JOIN lead_stages     st  ON st.id  = l.stage_id
      LEFT JOIN lead_sub_stages sst ON sst.id = l.sub_stage_id
      LEFT JOIN programs        p   ON p.id   = l.program_id
      LEFT JOIN branches        br  ON br.id  = l.branch_id
      LEFT JOIN users           owner ON owner.id = l.assigned_to
      LEFT JOIN users           mgr   ON mgr.id   = l.manager_id
      LEFT JOIN LATERAL (
        SELECT la.from_user_id, la.created_at
          FROM lead_assignments la
         WHERE la.lead_id = l.id AND la.from_user_id IS NOT NULL
         ORDER BY la.created_at DESC LIMIT 1
      ) prev ON true
      LEFT JOIN users prev_u ON prev_u.id = prev.from_user_id
     WHERE l.id = $1 AND l.deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};
