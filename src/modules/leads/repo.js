import { tenantQuery, tenantTx } from '../../db/tenant.js';

// Follow-up date-window bounds normalization.
//
// The FE date picker sends bare `YYYY-MM-DD` strings, which Postgres coerces
// to midnight (00:00:00). For a "from" bound that's the correct start-of-day,
// but for a "to" bound it makes the window end at the very first instant of
// that day — so picking "Jun 1 → Jun 1" (or any single day) matches a single
// midnight instant and returns nothing. Expand a bare-date "to" bound to the
// end of that day so an inclusive [from, to] range covers whole days.
// Full timestamps (anything carrying a 'T' / time component) are passed
// through untouched — callers that send precise instants get exact behaviour.
const isBareDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const followupToBound = (v) => (isBareDate(v) ? `${v}T23:59:59.999` : v);

export const LEAD_COLUMNS = `
  id, name, first_name, last_name, alternate_first_name, email, alternate_email,
  phone, whatsapp_number, alternate_contact, gender, language,
  ug_degree_id, ug_specialization_id, ug_university_id, ug_graduation_year,
  pg_degree_id, pg_specialization_id, pg_university_id, pg_graduation_year,
  country_id, state_id, district, city, address, pincode,
  program_id, stage_id, sub_stage_id, remarks, closure_remarks,
  assigned_to, team_id, branch_id, created_by,
  lead_score, lead_score_manual_override, engagement_score, lead_value,
  referred_by_lead_id, referral_code_used, referral_source,
  first_touch_campaign_id, first_touch_channel, first_touch_source, first_touch_medium, first_touch_at,
  last_touch_campaign_id, last_touch_channel, last_touch_source, last_touch_medium, last_touch_at,
  mobile_verified_at, email_verified_at, is_cold,
  converted_at, merged_into_id,
  primary_source_id,
  created_at, updated_at, last_activity_at
`;

// Duplicate detection by email (case-insensitive) + phone/whatsapp.
//
// Phone and whatsapp are matched on their DIGITS ONLY (last 10 retained, so
// "9322994226", "+919322994226" and "0919322994226" all collide) rather than
// raw-string equality — institutes' sheets carry the same number in wildly
// different formats and exact-string matching let obvious dupes through.
//
// `matchPhone` (default true) controls whether phone participates. The manual-
// create path leaves it true (phone is a strong dedup signal there). The bulk-
// import path passes false because phone is noisy at scale (institutes share
// family numbers across leads), and only flips it back to true for a given row
// when that row carries NEITHER email NOR whatsapp — otherwise identical
// phone-only rows have nothing to dedup on and slip in as dupes (the original
// bug). See the bulk-import worker for that per-row decision.
const last10Digits = (v) => {
  const d = String(v ?? '').replace(/\D+/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};

export const findDuplicates = async (
  tenant,
  { phone, email, whatsapp_number },
  { excludeId, matchPhone = true } = {},
) => {
  const conds = [];
  const params = [];
  if (email) { params.push(email); conds.push(`lower(email::text) = lower($${params.length}::text)`); }
  // Match phone/whatsapp on the last-10 digits of the stored value against the
  // last-10 digits of the incoming value (computed in JS, passed as a param).
  const digitCond = (col, val) => {
    const d = last10Digits(val);
    if (d.length < 10) return; // too short to be a reliable phone match
    params.push(d);
    conds.push(`right(regexp_replace(coalesce(${col},''), '\\D', '', 'g'), 10) = $${params.length}`);
  };
  if (whatsapp_number) {
    digitCond('whatsapp_number', whatsapp_number);
    digitCond('phone', whatsapp_number); // a lead's phone may hold this number
  }
  if (phone && matchPhone) {
    digitCond('phone', phone);
    digitCond('whatsapp_number', phone); // a lead's whatsapp may hold this number
  }
  if (!conds.length) return [];
  let q = `SELECT id, name, email, phone, whatsapp_number, stage_id, assigned_to, created_at
             FROM leads
            WHERE deleted_at IS NULL AND (${conds.join(' OR ')})`;
  if (excludeId) { params.push(excludeId); q += ` AND id <> $${params.length}`; }
  q += ' ORDER BY created_at DESC LIMIT 10';
  const { rows } = await tenantQuery(tenant, q, params);
  return rows;
};

export const insertLead = async (tenant, input, created_by) => tenantTx(tenant, async (client) => {
  // Main lead row.
  //
  // `followups` is a virtual array passed by callers (manual create form +
  // bulk import) that needs separate inserts into lead_followups — handled
  // at the end of this function. We strip it out of the main column loop.
  //
  // `created_at` / `updated_at` are honored when callers pass them
  // (e.g. CSV migration from another CRM). Blank / missing → Postgres
  // defaults to now() via the column DEFAULT.
  const cols = [];
  const vals = [];
  const placeholders = [];
  let i = 1;
  for (const [k, v] of Object.entries(input)) {
    if (['family', 'custom_values', 'sources', 'followups'].includes(k)) continue;
    if (v === undefined) continue;
    cols.push(k);
    vals.push(v);
    placeholders.push(`$${i}`);
    i += 1;
  }
  if (created_by) { cols.push('created_by'); vals.push(created_by); placeholders.push(`$${i}`); i += 1; }
  if (input.first_touch_campaign_id || input.first_touch_channel) {
    cols.push('first_touch_at'); vals.push(new Date()); placeholders.push(`$${i}`); i += 1;
  }
  // Default the lead into the first pipeline stage when the caller didn't pick
  // one (e.g. Quick Add sends no stage). Without this the lead lands with
  // stage_id = NULL and the UI shows "Unassigned stage". Pick the lowest
  // order_index active stage (normally "01-New").
  if (input.stage_id === undefined || input.stage_id === null) {
    const { rows: firstStage } = await client.query(
      `SELECT id FROM lead_stages WHERE is_active = true AND deleted_at IS NULL
        ORDER BY order_index ASC, name ASC LIMIT 1`,
    );
    if (firstStage[0]?.id) {
      cols.push('stage_id'); vals.push(firstStage[0].id); placeholders.push(`$${i}`); i += 1;
    }
  }
  const { rows } = await client.query(
    `INSERT INTO leads (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING ${LEAD_COLUMNS}`,
    vals,
  );
  const lead = rows[0];

  // If the lead was created directly into a success stage (e.g. backfill), stamp converted_at.
  if (lead.stage_id) {
    const { rows: stageRows } = await client.query(`SELECT is_success FROM lead_stages WHERE id = $1`, [lead.stage_id]);
    if (stageRows[0]?.is_success && !lead.converted_at) {
      await client.query(`UPDATE leads SET converted_at = now() WHERE id = $1`, [lead.id]);
      lead.converted_at = new Date();
    }
  }

  // Family
  if (input.family) {
    const famCols = ['lead_id'];
    const famVals = [lead.id];
    const famPlc = ['$1'];
    let j = 2;
    for (const [k, v] of Object.entries(input.family)) {
      if (v === undefined) continue;
      famCols.push(k); famVals.push(v); famPlc.push(`$${j}`); j += 1;
    }
    await client.query(
      `INSERT INTO lead_family (${famCols.join(',')}) VALUES (${famPlc.join(',')})`,
      famVals,
    );
  }

  // Custom values
  if (input.custom_values && Object.keys(input.custom_values).length) {
    const keys = Object.keys(input.custom_values);
    const { rows: defs } = await client.query(
      `SELECT id, key, field_type FROM custom_field_definitions WHERE entity = 'lead' AND key = ANY($1::text[]) AND deleted_at IS NULL`,
      [keys],
    );
    for (const def of defs) {
      await client.query(
        `INSERT INTO lead_custom_values (lead_id, field_id, value)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (lead_id, field_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [lead.id, def.id, JSON.stringify(input.custom_values[def.key])],
      );
    }
  }

  // Source attributions. Null out any dictionary id whose row has been deleted
  // — the FE may still hold a stale id from before the dropdown row was removed.
  if (input.sources && input.sources.length) {
    const exists = async (table, val) => {
      if (!val) return false;
      const { rows: r } = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [val]);
      return r.length > 0;
    };
    for (const [idx, s] of input.sources.entries()) {
      const channelId = (await exists('lead_channels', s.channel_id)) ? s.channel_id : null;
      const sourceId = (await exists('lead_sources_dict', s.source_id)) ? s.source_id : null;
      const campaignId = (await exists('lead_campaigns_dict', s.campaign_id)) ? s.campaign_id : null;
      const mediumId = (await exists('lead_mediums', s.medium_id)) ? s.medium_id : null;
      await client.query(
        `INSERT INTO lead_source_attributions (lead_id, channel_id, source_id, campaign_id, medium_id, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [lead.id, channelId, sourceId, campaignId, mediumId, s.is_primary ?? idx === 0],
      );
    }
  }

  // Lead assignment history row if assigned. Also snap manager_id + branch_id
  // from the assignee so the LeadCard hierarchy chip + manager leadlist filter
  // + branch scoping are correct from the moment the row exists. The same
  // snapping happens on auto-assign (rule-processor) and manual reassign
  // (lead-assignments routes); keeping it here closes the create path.
  if (input.assigned_to) {
    const { rows: mgrRows } = await client.query(
      `SELECT manager_id, branch_id FROM users WHERE id = $1`,
      [input.assigned_to],
    );
    const newManagerId = mgrRows[0]?.manager_id ?? null;
    const newBranchId = mgrRows[0]?.branch_id ?? null;
    await client.query(
      `UPDATE leads SET manager_id = $2, branch_id = $3 WHERE id = $1`,
      [lead.id, newManagerId, newBranchId],
    );
    lead.manager_id = newManagerId;
    lead.branch_id = newBranchId;
    await client.query(
      `INSERT INTO lead_assignments
         (lead_id, assigned_to, assigned_by, assignment_type, is_active, status,
          stage_id_at_transfer, sub_stage_id_at_transfer)
       VALUES ($1,$2,$3,'assign',true,'open',$4,$5)`,
      [lead.id, input.assigned_to, created_by, lead.stage_id ?? null, lead.sub_stage_id ?? null],
    );
  }

  // Guarantee EVERY lead carries a branch (no branchless leads). The assignee
  // snap above covers the common case; for an unassigned lead, an assignee with
  // no branch (e.g. super_admin), or an admin-created lead, fall back to:
  //   1) the creator's branch, then
  //   2) the tenant's sole branch (only when exactly one exists — we can't pick
  //      among many without an owner to derive it from).
  if (!lead.branch_id) {
    let fallbackBranch = null;
    if (created_by) {
      const cr = await client.query(`SELECT branch_id FROM users WHERE id = $1`, [created_by]);
      fallbackBranch = cr.rows[0]?.branch_id ?? null;
    }
    if (!fallbackBranch) {
      const only = await client.query(`SELECT id FROM branches WHERE deleted_at IS NULL LIMIT 2`);
      if (only.rows.length === 1) fallbackBranch = only.rows[0].id;
    }
    if (fallbackBranch) {
      await client.query(`UPDATE leads SET branch_id = $2 WHERE id = $1`, [lead.id, fallbackBranch]);
      lead.branch_id = fallbackBranch;
    }
  }

  // Initial activity. Force created_at to clock_timestamp() (live wall time
  // inside the txn) so the follow-up 'assign' row below — written in the
  // same statement-time tick — sorts strictly after this one in the
  // timeline. Without this, both rows take statement_timestamp() and end
  // up at the exact same millisecond, which makes the UI flip them.
  await client.query(
    `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json, created_at)
     VALUES ($1,$2,'lead_created','Lead created',$3::jsonb, clock_timestamp())`,
    [lead.id, created_by ?? null, JSON.stringify({ source: 'api' })],
  );

  // If the form pre-assigned an owner, the timeline should also show an
  // 'assign' event so the "Counselor Activity" filter on the lead drawer
  // sees it (mirrors the auto_assign row dropped by the worker).
  if (input.assigned_to) {
    await client.query(
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json, created_at)
       VALUES ($1,$2,'assign','Assigned on creation',$3::jsonb, clock_timestamp())`,
      [lead.id, created_by ?? null, JSON.stringify({ assigned_to: input.assigned_to })],
    );
  }

  // Follow-up rows. Per-stage 5-slot history: each row carries stage_id
  // (required when slot_index is set) and optional sub_stage_id. Manual
  // create form sends past slots (status='done', slot_index 1..5) and
  // optionally one upcoming planned row. Bulk import sends the same
  // shape from CSV columns.
  //
  // We deliberately do NOT de-duplicate by (datetime, comment). The product
  // rule is "store exactly what the user typed in each slot, even if two
  // slots are identical" so the slot order in the UI matches the CSV 1:1.
  //
  // is_success stages are rejected — no follow-up rows survive a Converted
  // stage by policy.
  if (Array.isArray(input.followups) && input.followups.length) {
    // Cache stage success-flags so we don't re-query for every row.
    const stageSuccessCache = new Map();
    const isSuccessStage = async (sId) => {
      if (!sId) return false;
      if (stageSuccessCache.has(sId)) return stageSuccessCache.get(sId);
      const r = await client.query(`SELECT is_success FROM lead_stages WHERE id = $1`, [sId]);
      const v = r.rows[0]?.is_success === true;
      stageSuccessCache.set(sId, v);
      return v;
    };
    // App-level uniqueness on (lead_id, stage_id, slot_index): later rows
    // with the same key win — matches "user retyped this slot" intent.
    const slotKeysSeen = new Set();
    for (const f of input.followups) {
      if (!f || !f.next_action_datetime) continue;
      const status = f.status ?? 'planned';
      const completed_at = status === 'done' ? f.next_action_datetime : null;
      const slotIndex = Number.isInteger(f.slot_index) && f.slot_index >= 1 && f.slot_index <= 5
        ? f.slot_index
        : null;
      const stageId = f.stage_id ?? null;
      const subStageId = f.sub_stage_id ?? null;
      if (slotIndex !== null && !stageId) continue; // slot rows must carry stage
      if (await isSuccessStage(stageId)) continue;  // Converted stages own no followups
      if (slotIndex !== null) {
        const k = `${stageId}|${slotIndex}`;
        if (slotKeysSeen.has(k)) continue;
        slotKeysSeen.add(k);
      }
      await client.query(
        `INSERT INTO lead_followups
            (lead_id, next_action_datetime, comment, status, created_by,
             completed_at, completed_by, slot_index, stage_id, sub_stage_id,
             created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()), COALESCE($11, now()))`,
        [
          lead.id,
          f.next_action_datetime,
          f.comment ?? null,
          status,
          created_by ?? null,
          completed_at,
          completed_at ? (created_by ?? null) : null,
          slotIndex,
          stageId,
          subStageId,
          // Backdate created_at of past attempts to the action date itself so
          // any consumer that sorts by created_at still gets a reasonable
          // chronological view. Slot-order callers should sort by slot_index
          // instead.
          status === 'done' ? f.next_action_datetime : null,
        ],
      );
    }
  }

  return lead;
});

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
};

// Override the snapshot `manager_id` set by insertLead (which uses the
// assignee's primary `users.manager_id`). Quick-add by a counsellor with
// multiple managers needs to point at the *first* row in user_managers
// instead — done here rather than in insertLead so the regular create
// path stays unchanged.
export const setManagerId = async (tenant, id, manager_id) => {
  await tenantQuery(
    tenant,
    `UPDATE leads SET manager_id = $2 WHERE id = $1 AND deleted_at IS NULL`,
    [id, manager_id],
  );
};

// Stamp the owning branch on a lead. Used for unassigned quick-adds by a
// branch/sales manager, where there's no assignee to snap branch_id from.
export const setBranchId = async (tenant, id, branch_id) => {
  await tenantQuery(
    tenant,
    `UPDATE leads SET branch_id = $2 WHERE id = $1 AND deleted_at IS NULL`,
    [id, branch_id ?? null],
  );
};

// One-time adoption: stamp EVERY branch-less lead (assigned or not) with a
// branch. Used by the "create first branch and adopt everyone" flow where the
// tenant has a single branch, so no lead should be left branch-less. Runs on a
// tx client for atomicity with the user adoption. Returns rows affected.
export const stampBranchOnUnbranchedLeads = async (client, branch_id) => {
  const { rowCount } = await client.query(
    `UPDATE leads SET branch_id = $1 WHERE branch_id IS NULL AND deleted_at IS NULL`,
    [branch_id],
  );
  return rowCount;
};

export const findByIdWithRelations = async (tenant, id) => {
  const base = await findById(tenant, id);
  if (!base) return null;
  const [family, sources, tagsRes, customValuesRes, assignmentsRes, primarySourceRes, followupsRes] = await Promise.all([
    tenantQuery(tenant, `SELECT * FROM lead_family WHERE lead_id = $1`, [id]),
    tenantQuery(tenant, `
      SELECT lsa.*,
             ch.name AS channel_name,
             sd.name AS source_name,
             cd.name AS campaign_name,
             md.name AS medium_name
        FROM lead_source_attributions lsa
        LEFT JOIN lead_channels       ch ON ch.id = lsa.channel_id
        LEFT JOIN lead_sources_dict   sd ON sd.id = lsa.source_id
        LEFT JOIN lead_campaigns_dict cd ON cd.id = lsa.campaign_id
        LEFT JOIN lead_mediums        md ON md.id = lsa.medium_id
       WHERE lead_id = $1
       ORDER BY is_primary DESC, captured_at
    `, [id]),
    tenantQuery(tenant, `SELECT t.id, t.name, t.color FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = $1 AND t.deleted_at IS NULL`, [id]),
    tenantQuery(tenant, `
      SELECT d.key, d.label, d.field_type, v.value
        FROM lead_custom_values v
        JOIN custom_field_definitions d ON d.id = v.field_id
       WHERE v.lead_id = $1 AND d.deleted_at IS NULL
    `, [id]),
    // Ownership history. Includes the current active row at the top.
    // LeadCard / timeline use this to render previous → current chain.
    tenantQuery(tenant, `
      SELECT la.id, la.assigned_to, la.from_user_id, la.assigned_by,
             la.assignment_type, la.is_active, la.reason, la.created_at,
             u_to.name   AS assigned_to_name,
             u_to.email  AS assigned_to_email,
             u_from.name AS from_user_name,
             u_by.name   AS assigned_by_name
        FROM lead_assignments la
        LEFT JOIN users u_to   ON u_to.id   = la.assigned_to
        LEFT JOIN users u_from ON u_from.id = la.from_user_id
        LEFT JOIN users u_by   ON u_by.id   = la.assigned_by
       WHERE la.lead_id = $1
       ORDER BY la.is_active DESC, la.created_at DESC
    `, [id]),
    tenantQuery(tenant, `SELECT id, name FROM lead_primary_sources WHERE id = $1`, [base.primary_source_id]),
    // All follow-ups for this lead. Sort order matters:
    //   • slot_index ASC NULLS LAST — rows that came from CSV columns 1..5
    //     keep their column order so the LeadCard "5 slots" view matches
    //     what the user typed, even when slot 1's date is later than slot 2's.
    //   • next_action_datetime DESC tiebreaker — for ad-hoc rows
    //     (slot_index NULL) we still want most-recent first.
    tenantQuery(tenant, `
      SELECT id, next_action_datetime, comment, status, completed_at,
             completion_reason, slot_index, stage_id, sub_stage_id,
             created_at, updated_at
        FROM lead_followups
       WHERE lead_id = $1 AND deleted_at IS NULL
       ORDER BY stage_id NULLS LAST, slot_index ASC NULLS LAST, next_action_datetime DESC
    `, [id]),
  ]);
  // Resolve the owning branch's name (for the read-only Branch field on the
  // edit form). Cheap point lookup; null when the lead has no branch yet.
  let branch_name = null;
  if (base.branch_id) {
    const br = await tenantQuery(tenant, `SELECT name FROM branches WHERE id = $1 AND deleted_at IS NULL`, [base.branch_id]);
    branch_name = br.rows[0]?.name ?? null;
  }
  const custom_values = {};
  for (const r of customValuesRes.rows) custom_values[r.key] = r.value;
  const assignments = assignmentsRes.rows;
  // Surface the two most recent owners for FE convenience. The active row is
  // current_owner; the most recent inactive row is previous_owner.
  const current_owner = assignments.find((a) => a.is_active) ?? null;
  const previous_owner = assignments.find((a) => !a.is_active) ?? null;
  // Split follow-ups so the FE has both shapes ready:
  //   • upcoming — status='planned' rows with future-or-present action time
  //   • past     — completed/missed/cancelled rows, most recent first
  // The LeadCard slots view fills with `past.slice(0,5)`; the Full History
  // tab renders both arrays together.
  const allFollowups = followupsRes.rows;
  const upcoming_followups = allFollowups.filter((f) => f.status === 'planned');
  const past_followups = allFollowups.filter((f) => f.status !== 'planned');
  // Per-stage 5-slot grouping for the FE form. Only stage-scoped slot rows
  // (slot_index 1..5, stage_id set) participate; ad-hoc rows stay flat in
  // `followups` / `past_followups`. Each stage gets a 5-element array;
  // missing slots are null so the FE can render fixed-width grids.
  const followups_by_stage = {};
  for (const f of allFollowups) {
    if (!f.stage_id || !Number.isInteger(f.slot_index)) continue;
    if (f.slot_index < 1 || f.slot_index > 5) continue;
    if (!followups_by_stage[f.stage_id]) followups_by_stage[f.stage_id] = [null, null, null, null, null];
    followups_by_stage[f.stage_id][f.slot_index - 1] = f;
  }
  return {
    ...base,
    branch_name,
    family: family.rows[0] ?? null,
    sources: sources.rows,
    tags: tagsRes.rows,
    custom_values,
    primary_source: primarySourceRes.rows[0] ?? null,
    assignments,
    current_owner,
    previous_owner,
    followups: allFollowups,
    upcoming_followups,
    past_followups,
    followups_by_stage,
  };
};

export const updateLead = async (tenant, id, updates, actorId = null) => tenantTx(tenant, async (client) => {
  const fields = [];
  const params = [];
  let i = 1;
  const { family, custom_values, sources, ...scalar } = updates;

  // Snapshot stage/sub-stage BEFORE the UPDATE so we can detect a real
  // transition and log a `stage_changed` activity. Historically only the
  // POST /leads/:id/stage endpoint wrote this row, so any PUT that
  // touched stage_id (the AddNewLead dialog on Save) silently moved the
  // column without leaving an audit trail — which is why the timeline
  // showed nothing after admin stage edits. Capture the old values once.
  let preStage = null;
  if (scalar.stage_id !== undefined || scalar.sub_stage_id !== undefined) {
    const { rows: pre } = await client.query(
      `SELECT stage_id, sub_stage_id FROM leads WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    preStage = pre[0] ?? null;
  }

  for (const [k, v] of Object.entries(scalar)) {
    if (v === undefined) continue;
    fields.push(`${k} = $${i}`);
    params.push(v);
    i += 1;
  }
  if (fields.length) {
    fields.push(`last_activity_at = now()`);
    params.push(id);
    await client.query(`UPDATE leads SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL`, params);
  }

  // If stage_id changed via this update, mirror the converted_at flip.
  if (scalar.stage_id !== undefined) {
    const r = await client.query(`SELECT is_success FROM lead_stages WHERE id = $1`, [scalar.stage_id]);
    if (r.rows[0]?.is_success) {
      await client.query(`UPDATE leads SET converted_at = COALESCE(converted_at, now()) WHERE id = $1`, [id]);
    } else {
      await client.query(`UPDATE leads SET converted_at = NULL WHERE id = $1`, [id]);
    }
  }

  // Emit a `stage_changed` audit activity when the PUT actually moved
  // stage or sub-stage. Two callers can hit this path right now:
  //   - The AddNewLead dialog Save (FE then also fires POST /stage when
  //     it sees a delta; the repo.changeStage no-op short-circuit means
  //     that second call won't double-log).
  //   - Any other PUT caller (Postman, future inline edit). They no
  //     longer slip past the timeline.
  if (preStage) {
    const newStageId  = scalar.stage_id !== undefined ? scalar.stage_id : preStage.stage_id;
    const newSubId    = scalar.sub_stage_id !== undefined ? scalar.sub_stage_id : preStage.sub_stage_id;
    const stageMoved  = String(preStage.stage_id ?? '')     !== String(newStageId ?? '');
    const subMoved    = String(preStage.sub_stage_id ?? '') !== String(newSubId ?? '');
    if (stageMoved || subMoved) {
      // Match the converted-flag shape that POST /stage writes so the
      // FE's stage_changed card renders the same way regardless of which
      // path actually emitted the row.
      let converted = null;
      if (stageMoved) {
        const [wasS, willS] = await Promise.all([
          preStage.stage_id
            ? client.query(`SELECT is_success FROM lead_stages WHERE id = $1`, [preStage.stage_id])
            : Promise.resolve({ rows: [] }),
          newStageId
            ? client.query(`SELECT is_success FROM lead_stages WHERE id = $1`, [newStageId])
            : Promise.resolve({ rows: [] }),
        ]);
        const wasSuccess  = wasS.rows[0]?.is_success === true;
        const willSuccess = willS.rows[0]?.is_success === true;
        if (!wasSuccess && willSuccess) converted = true;
        else if (wasSuccess && !willSuccess) converted = false;
      }
      await client.query(
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
         VALUES ($1,$2,'stage_changed','Stage changed',$3::jsonb)`,
        [id, actorId, JSON.stringify({
          from: preStage.stage_id, to: newStageId,
          from_sub: preStage.sub_stage_id, to_sub: newSubId,
          converted,
        })],
      );
    }
  }

  if (family) {
    // Upsert family
    await client.query(
      `INSERT INTO lead_family (lead_id, father_name, father_mobile, father_email, mother_name, mother_mobile, mother_email, guardian_name, guardian_mobile, guardian_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (lead_id) DO UPDATE SET
         father_name = EXCLUDED.father_name, father_mobile = EXCLUDED.father_mobile, father_email = EXCLUDED.father_email,
         mother_name = EXCLUDED.mother_name, mother_mobile = EXCLUDED.mother_mobile, mother_email = EXCLUDED.mother_email,
         guardian_name = EXCLUDED.guardian_name, guardian_mobile = EXCLUDED.guardian_mobile, guardian_email = EXCLUDED.guardian_email,
         updated_at = now()`,
      [id, family.father_name ?? null, family.father_mobile ?? null, family.father_email ?? null,
       family.mother_name ?? null, family.mother_mobile ?? null, family.mother_email ?? null,
       family.guardian_name ?? null, family.guardian_mobile ?? null, family.guardian_email ?? null],
    );
  }

  if (custom_values) {
    const keys = Object.keys(custom_values);
    if (keys.length) {
      const { rows: defs } = await client.query(
        `SELECT id, key FROM custom_field_definitions WHERE entity = 'lead' AND key = ANY($1::text[]) AND deleted_at IS NULL`,
        [keys],
      );
      for (const def of defs) {
        await client.query(
          `INSERT INTO lead_custom_values (lead_id, field_id, value)
           VALUES ($1,$2,$3::jsonb)
           ON CONFLICT (lead_id, field_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [id, def.id, JSON.stringify(custom_values[def.key])],
        );
      }
    }
  }

  if (Array.isArray(sources)) {
    // Replace source attributions (destructive; treat UI as authoritative for this array).
    // Null out any dictionary id whose row has been deleted — the FE may still hold a
    // stale id from before the dropdown row was removed, and a blind insert would
    // trip the channel/source/campaign/medium FK.
    await client.query(`DELETE FROM lead_source_attributions WHERE lead_id = $1`, [id]);
    const exists = async (table, val) => {
      if (!val) return false;
      const { rows: r } = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [val]);
      return r.length > 0;
    };
    for (const [idx, s] of sources.entries()) {
      const channelId = (await exists('lead_channels', s.channel_id)) ? s.channel_id : null;
      const sourceId = (await exists('lead_sources_dict', s.source_id)) ? s.source_id : null;
      const campaignId = (await exists('lead_campaigns_dict', s.campaign_id)) ? s.campaign_id : null;
      const mediumId = (await exists('lead_mediums', s.medium_id)) ? s.medium_id : null;
      await client.query(
        `INSERT INTO lead_source_attributions (lead_id, channel_id, source_id, campaign_id, medium_id, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, channelId, sourceId, campaignId, mediumId, s.is_primary ?? idx === 0],
      );
    }
  }

  const { rows } = await client.query(`SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1`, [id]);
  return rows[0] ?? null;
});

export const softDelete = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE leads SET deleted_at = now() WHERE id = $1`, [id]);
};

// Replace the 5 slot rows for a single (lead, stage). Non-destructive:
// rows that no longer appear in the input are soft-deleted (deleted_at set),
// never physically removed; existing rows for the same (lead, stage, slot)
// are UPDATE-d in place so their id stays stable.
//
// Input shape: rows = [{ slot_index: 1..5, next_action_datetime, comment?,
// sub_stage_id?, status? }, ...]. Rows without a datetime are ignored.
//
// Rejects entirely if the stage is is_success — Converted stages own no
// followups.
export const replaceFollowupsForStage = async (tenant, lead_id, stage_id, rows, actor_id) =>
  tenantTx(tenant, async (client) => {
    if (!lead_id || !stage_id) return { written: 0 };
    const { rows: stageRow } = await client.query(
      `SELECT is_success FROM lead_stages WHERE id = $1`,
      [stage_id],
    );
    if (stageRow[0]?.is_success) return { written: 0, skipped_reason: 'is_success_stage' };

    const incomingBySlot = new Map();
    for (const r of rows || []) {
      // A slot is kept when it has a date OR a non-empty comment. Previously
      // a comment typed without a date was silently dropped here.
      const hasComment = typeof r?.comment === 'string' && r.comment.trim().length > 0;
      if (!r?.next_action_datetime && !hasComment) continue;
      const slot = Number.isInteger(r.slot_index) && r.slot_index >= 1 && r.slot_index <= 5
        ? r.slot_index : null;
      if (slot === null) continue;
      incomingBySlot.set(slot, r);
    }

    const { rows: existing } = await client.query(
      `SELECT id, slot_index FROM lead_followups
        WHERE lead_id = $1 AND stage_id = $2 AND slot_index IS NOT NULL
          AND deleted_at IS NULL`,
      [lead_id, stage_id],
    );
    const existingBySlot = new Map(existing.map((e) => [e.slot_index, e.id]));

    // Soft-delete slot rows not present in the new payload.
    for (const [slot, existingId] of existingBySlot) {
      if (!incomingBySlot.has(slot)) {
        await client.query(
          `UPDATE lead_followups SET deleted_at = now(), updated_at = now()
            WHERE id = $1 AND deleted_at IS NULL`,
          [existingId],
        );
      }
    }

    let written = 0;
    for (const [slot, r] of incomingBySlot) {
      const nextAt = r.next_action_datetime || null;
      const comment = typeof r.comment === 'string' && r.comment.trim() ? r.comment : null;
      // A comment-only slot (no date) can't be 'done' — there's nothing to
      // have completed. Keep it 'planned' so completed_at stays null and the
      // NOT NULL date assumption is never relied on.
      const status = !nextAt ? 'planned' : (r.status ?? 'done');
      const completedAt = status === 'done' && nextAt ? nextAt : null;
      const subStageId = r.sub_stage_id ?? null;
      const existingId = existingBySlot.get(slot);
      if (existingId) {
        await client.query(
          `UPDATE lead_followups
              SET next_action_datetime = $1,
                  comment = $2,
                  status = $3,
                  sub_stage_id = $4,
                  completed_at = $5,
                  completed_by = COALESCE(completed_by, $6),
                  updated_at = now()
            WHERE id = $7`,
          [nextAt, comment, status, subStageId,
           completedAt, completedAt ? actor_id ?? null : null, existingId],
        );
      } else {
        await client.query(
          `INSERT INTO lead_followups
              (lead_id, next_action_datetime, comment, status, created_by,
               completed_at, completed_by, slot_index, stage_id, sub_stage_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [lead_id, nextAt, comment, status,
           actor_id ?? null, completedAt,
           completedAt ? actor_id ?? null : null, slot, stage_id, subStageId],
        );
      }
      written += 1;
    }
    return { written };
  });

// Upsert the single ad-hoc PLANNED follow-up that the "Followup Scheduled On"
// + "Follow up Comments" fields at the top of the Edit Lead form represent.
// These are NOT slot rows (slot_index IS NULL) — there's one logical "next
// scheduled action" per lead. We keep exactly one open planned ad-hoc row:
//   • date + (optional) comment  -> upsert that one row
//   • comment only (no date)     -> upsert a dateless planned row so the note
//                                   is never lost
//   • both empty                 -> soft-delete the existing ad-hoc planned row
// The row is stage-scoped to the lead's current stage so it survives the
// slot grouping above and shows correctly in the timeline / Follow-up Manager.
export const upsertAdHocPlannedFollowup = async (tenant, lead_id, { next_action_datetime, comment, stage_id, sub_stage_id }, actor_id) =>
  tenantTx(tenant, async (client) => {
    const nextAt = next_action_datetime || null;
    const note = typeof comment === 'string' && comment.trim() ? comment : null;

    const { rows: existing } = await client.query(
      `SELECT id FROM lead_followups
        WHERE lead_id = $1 AND slot_index IS NULL AND status = 'planned'
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [lead_id],
    );
    const existingId = existing[0]?.id ?? null;

    // Nothing to record — clear any stale open ad-hoc row and stop.
    if (!nextAt && !note) {
      if (existingId) {
        await client.query(
          `UPDATE lead_followups SET deleted_at = now(), updated_at = now() WHERE id = $1`,
          [existingId],
        );
      }
      return { written: 0 };
    }

    if (existingId) {
      await client.query(
        `UPDATE lead_followups
            SET next_action_datetime = $1, comment = $2,
                stage_id = COALESCE($3, stage_id),
                sub_stage_id = COALESCE($4, sub_stage_id),
                updated_at = now()
          WHERE id = $5`,
        [nextAt, note, stage_id ?? null, sub_stage_id ?? null, existingId],
      );
      return { written: 1, id: existingId };
    }

    const { rows } = await client.query(
      `INSERT INTO lead_followups
          (lead_id, next_action_datetime, comment, status, created_by, stage_id, sub_stage_id)
       VALUES ($1, $2, $3, 'planned', $4, $5, $6)
       RETURNING id`,
      [lead_id, nextAt, note, actor_id ?? null, stage_id ?? null, sub_stage_id ?? null],
    );
    return { written: 1, id: rows[0].id };
  });

// Hard-delete: physically remove the lead row. Foreign-key cascades clean up
// lead_family / lead_source_attributions / lead_custom_values / lead_tags /
// lead_followups / lead_notes / lead_assignments / lead_activities / calls /
// message_log etc. All restricted to super_admin at the route layer.
export const hardDelete = async (tenant, id) => tenantTx(tenant, async (client) => {
  await client.query(`DELETE FROM leads WHERE id = $1`, [id]);
});

// Bulk hard-delete: same semantics as hardDelete but takes an array of ids
// and runs in one transaction. FK CASCADEs wipe every dependent row
// (followups, notes, assignments, activities, family, source attributions,
// custom values, tags, calls, recordings, payments, referral edges, etc.)
// so nothing about the deleted leads survives in the tenant DB.
//
// Returns the count actually deleted so the caller can compare it against
// the requested list (mismatches mean some ids were already gone or out of
// scope; we still report success since the end state is correct).
//
// Super-admin only — enforced at the route layer.
export const hardDeleteMany = async (tenant, ids) => tenantTx(tenant, async (client) => {
  if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
  const r = await client.query(
    `DELETE FROM leads WHERE id = ANY($1::uuid[]) RETURNING id`,
    [ids],
  );
  return { deleted: r.rowCount, deleted_ids: r.rows.map((row) => row.id) };
});

export const changeStage = async (tenant, id, { stage_id, sub_stage_id, remarks }, user_id) => tenantTx(tenant, async (client) => {
  const { rows: oldRows } = await client.query(`SELECT stage_id, sub_stage_id FROM leads WHERE id = $1 AND deleted_at IS NULL`, [id]);
  const old = oldRows[0];
  if (!old) return null;

  // No-op short-circuit: callers (the lead-edit dialog, public forms, the
  // bulk-action endpoint) sometimes re-submit the same stage/sub-stage on
  // save. Don't write a `stage_changed` activity row for that — it pollutes
  // the timeline with "Enrolled → Enrolled" cards. The remark below is still
  // applied so a user editing only the remark on the same stage isn't lost.
  const stageUnchanged = String(old.stage_id) === String(stage_id);
  const subUnchanged = String(old.sub_stage_id ?? '') === String(sub_stage_id ?? '');
  if (stageUnchanged && subUnchanged) {
    if (remarks !== undefined && remarks !== null) {
      await client.query(
        `UPDATE leads SET remarks = $2, last_activity_at = now() WHERE id = $1`,
        [id, remarks],
      );
    }
    const { rows } = await client.query(`SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1`, [id]);
    return rows[0];
  }

  // Resolve the success-flag of both old and new stages so we can flip
  // converted_at on/off when the lead crosses a "success" boundary.
  const isSuccess = async (sId) => {
    if (!sId) return false;
    const r = await client.query(`SELECT is_success FROM lead_stages WHERE id = $1`, [sId]);
    return r.rows[0]?.is_success === true;
  };
  const wasSuccess = await isSuccess(old.stage_id);
  const willBeSuccess = await isSuccess(stage_id);
  // Only touch converted_at on transitions:
  //   not-success → success  : stamp now
  //   success → not-success  : clear (lead came back from "Enrolled")
  //   anything else          : leave alone
  let convertedAtSql = '';
  if (!wasSuccess && willBeSuccess) convertedAtSql = ', converted_at = now()';
  else if (wasSuccess && !willBeSuccess) convertedAtSql = ', converted_at = NULL';

  // lead_score is recomputed authoritatively by recalcScore() in the service
  // layer right after this transaction commits — that picks up the new
  // stage/sub-stage scores plus any matching lead_score_config rules in one
  // pass. Don't try to nudge it here.
  await client.query(
    `UPDATE leads
        SET stage_id        = $2,
            sub_stage_id    = $3,
            remarks         = COALESCE($4, remarks),
            last_activity_at = now()
            ${convertedAtSql}
      WHERE id = $1`,
    [id, stage_id, sub_stage_id ?? null, remarks ?? null],
  );
  await client.query(
    `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
     VALUES ($1,$2,'stage_changed',$3,$4::jsonb)`,
    [id, user_id ?? null, `Stage changed`, JSON.stringify({
      from: old.stage_id, to: stage_id,
      from_sub: old.sub_stage_id, to_sub: sub_stage_id ?? null,
      converted: !wasSuccess && willBeSuccess ? true : (wasSuccess && !willBeSuccess ? false : null),
    })],
  );
  const { rows } = await client.query(`SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1`, [id]);
  return rows[0];
});

export const getUpdatedAt = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT updated_at FROM leads WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0]?.updated_at ?? null;
};

// ---------- LISTING ----------
const sortClause = (sort) => {
  switch (sort) {
    case 'created_asc': return 'l.created_at ASC';
    case 'updated_desc': return 'l.updated_at DESC';
    case 'updated_asc': return 'l.updated_at ASC';
    case 'score_desc': return 'l.lead_score DESC, l.created_at DESC';
    case 'score_asc': return 'l.lead_score ASC, l.created_at DESC';
    case 'last_activity_desc': return 'l.last_activity_at DESC';
    // Per-column header sorts (NULLS LAST so blanks sink to the bottom either
    // way). Each pairs a *_asc / *_desc key with the matching joined column.
    case 'name_asc': return 'l.name ASC NULLS LAST';
    case 'name_desc': return 'l.name DESC NULLS LAST';
    case 'phone_asc': return 'l.phone ASC NULLS LAST';
    case 'phone_desc': return 'l.phone DESC NULLS LAST';
    case 'stage_asc': return 's.name ASC NULLS LAST';
    case 'stage_desc': return 's.name DESC NULLS LAST';
    case 'sub_stage_asc': return 'ss.name ASC NULLS LAST';
    case 'sub_stage_desc': return 'ss.name DESC NULLS LAST';
    case 'program_asc': return 'p.name ASC NULLS LAST';
    case 'program_desc': return 'p.name DESC NULLS LAST';
    case 'city_asc': return 'l.city ASC NULLS LAST';
    case 'city_desc': return 'l.city DESC NULLS LAST';
    case 'owner_asc': return 'u.name ASC NULLS LAST';
    case 'owner_desc': return 'u.name DESC NULLS LAST';
    case 'added_by_asc': return 'cb.name ASC NULLS LAST';
    case 'added_by_desc': return 'cb.name DESC NULLS LAST';
    // Age sorts on created_at INVERSELY: oldest lead = greatest age.
    case 'age_asc': return 'l.created_at DESC';
    case 'age_desc': return 'l.created_at ASC';
    default: return 'l.created_at DESC';
  }
};

// Shared WHERE-builder for `list` and `stageCounts`. Returns the params
// array (caller may push more), the conds list (so callers can append
// their own predicates), and the tagJoin clause (empty when no tag filter).
// `includeFlag` controls whether the `flag` overlays are baked in — the
// list endpoint wants them, but stageCounts builds them per-tab so it
// passes false.
const buildLeadWhere = (opts, scope, { includeFlag = true } = {}) => {
  const {
    q, stage_id, sub_stage_id, program_id, assigned_to, team_id, tag_id,
    country_id, state_id, city, district, pincode,
    channel_id, source_id, campaign_id, medium_id, primary_source_id,
    gender, language,
    ug_degree_id, pg_degree_id, ug_university_id, pg_university_id,
    ug_specialization_id, pg_specialization_id,
    ug_graduation_year, pg_graduation_year,
    lead_value, is_cold, is_converted, created_by, referral_code_used,
    email, phone, whatsapp_number,
    is_touched,
    lead_age_from, lead_age_to,
    lead_score_from, lead_score_to,
    followup_from, followup_to,
    date_from, date_to, flag,
    // Per-column header text search (match joined dimension by NAME) + the
    // Last-Updated date range. These power the column search boxes in the
    // Lead Manager table; they run against the whole tenant DB, not a page.
    stage_name, sub_stage_name, program_name, owner_name, added_by_name,
    updated_from, updated_to,
  } = opts;
  const conds = ['l.deleted_at IS NULL'];
  const params = [];
  if (stage_id) { params.push(stage_id); conds.push(`l.stage_id = $${params.length}`); }
  if (sub_stage_id) { params.push(sub_stage_id); conds.push(`l.sub_stage_id = $${params.length}`); }
  if (program_id) { params.push(program_id); conds.push(`l.program_id = $${params.length}`); }
  if (assigned_to) { params.push(assigned_to); conds.push(`l.assigned_to = $${params.length}`); }
  if (team_id) { params.push(team_id); conds.push(`l.team_id = $${params.length}`); }
  if (country_id) { params.push(country_id); conds.push(`l.country_id = $${params.length}`); }
  if (state_id) { params.push(state_id); conds.push(`l.state_id = $${params.length}`); }
  if (city) { params.push(`%${city}%`); conds.push(`l.city ILIKE $${params.length}`); }
  if (district) { params.push(`%${district}%`); conds.push(`l.district ILIKE $${params.length}`); }
  if (pincode) { params.push(`%${pincode}%`); conds.push(`l.pincode ILIKE $${params.length}`); }
  if (primary_source_id) { params.push(primary_source_id); conds.push(`l.primary_source_id = $${params.length}`); }
  if (gender) { params.push(gender); conds.push(`l.gender = $${params.length}`); }
  if (language) { params.push(language); conds.push(`l.language = $${params.length}`); }
  if (ug_degree_id) { params.push(ug_degree_id); conds.push(`l.ug_degree_id = $${params.length}`); }
  if (pg_degree_id) { params.push(pg_degree_id); conds.push(`l.pg_degree_id = $${params.length}`); }
  if (ug_university_id) { params.push(ug_university_id); conds.push(`l.ug_university_id = $${params.length}`); }
  if (pg_university_id) { params.push(pg_university_id); conds.push(`l.pg_university_id = $${params.length}`); }
  if (ug_specialization_id) { params.push(ug_specialization_id); conds.push(`l.ug_specialization_id = $${params.length}`); }
  if (pg_specialization_id) { params.push(pg_specialization_id); conds.push(`l.pg_specialization_id = $${params.length}`); }
  if (ug_graduation_year != null) { params.push(ug_graduation_year); conds.push(`l.ug_graduation_year = $${params.length}`); }
  if (pg_graduation_year != null) { params.push(pg_graduation_year); conds.push(`l.pg_graduation_year = $${params.length}`); }
  if (lead_value) { params.push(lead_value); conds.push(`l.lead_value = $${params.length}`); }
  if (is_cold === true) { conds.push(`l.is_cold = true`); }
  if (is_cold === false) { conds.push(`l.is_cold = false`); }
  if (is_converted === true) { conds.push(`l.converted_at IS NOT NULL`); }
  if (is_converted === false) { conds.push(`l.converted_at IS NULL`); }
  if (created_by) { params.push(created_by); conds.push(`l.created_by = $${params.length}`); }
  if (referral_code_used) { params.push(`%${referral_code_used}%`); conds.push(`l.referral_code_used ILIKE $${params.length}`); }
  if (email) { params.push(`%${email}%`); conds.push(`l.email::text ILIKE $${params.length}`); }
  if (phone) { params.push(`%${phone}%`); conds.push(`l.phone ILIKE $${params.length}`); }
  if (whatsapp_number) { params.push(`%${whatsapp_number}%`); conds.push(`l.whatsapp_number ILIKE $${params.length}`); }
  if (date_from) { params.push(date_from); conds.push(`l.created_at >= $${params.length}::timestamptz`); }
  if (date_to) { params.push(date_to); conds.push(`l.created_at <= $${params.length}::timestamptz`); }
  // Last-Updated date range (mirrors created_at's date_from/date_to).
  if (updated_from) { params.push(updated_from); conds.push(`l.updated_at >= $${params.length}::timestamptz`); }
  if (updated_to) { params.push(updated_to); conds.push(`l.updated_at <= $${params.length}::timestamptz`); }
  // Per-column NAME search via scalar subqueries — kept out of the JOINs so
  // the shared count query (which only joins tagJoin) stays valid.
  if (stage_name) { params.push(`%${stage_name}%`); conds.push(`EXISTS (SELECT 1 FROM lead_stages s2 WHERE s2.id = l.stage_id AND s2.name ILIKE $${params.length})`); }
  if (sub_stage_name) { params.push(`%${sub_stage_name}%`); conds.push(`EXISTS (SELECT 1 FROM lead_sub_stages ss2 WHERE ss2.id = l.sub_stage_id AND ss2.name ILIKE $${params.length})`); }
  if (program_name) { params.push(`%${program_name}%`); conds.push(`EXISTS (SELECT 1 FROM programs p2 WHERE p2.id = l.program_id AND p2.name ILIKE $${params.length})`); }
  if (owner_name) { params.push(`%${owner_name}%`); conds.push(`EXISTS (SELECT 1 FROM users uo WHERE uo.id = l.assigned_to AND uo.name ILIKE $${params.length})`); }
  if (added_by_name) { params.push(`%${added_by_name}%`); conds.push(`EXISTS (SELECT 1 FROM users ua WHERE ua.id = l.created_by AND ua.name ILIKE $${params.length})`); }
  if (lead_age_from != null) { params.push(lead_age_from); conds.push(`EXTRACT(EPOCH FROM (now() - l.created_at)) / 86400 >= $${params.length}`); }
  if (lead_age_to != null) { params.push(lead_age_to); conds.push(`EXTRACT(EPOCH FROM (now() - l.created_at)) / 86400 <= $${params.length}`); }
  if (lead_score_from != null) { params.push(lead_score_from); conds.push(`l.lead_score >= $${params.length}`); }
  if (lead_score_to != null) { params.push(lead_score_to); conds.push(`l.lead_score <= $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    const likeIdx = params.length;
    const digits = String(q).replace(/\D+/g, '');
    const branches = [
      `l.name ILIKE $${likeIdx}`,
      `l.email::text ILIKE $${likeIdx}`,
      `l.phone ILIKE $${likeIdx}`,
      `l.whatsapp_number ILIKE $${likeIdx}`,
      `l.alternate_contact ILIKE $${likeIdx}`,
    ];
    if (digits.length >= 4) {
      params.push(`%${digits}%`);
      const digitsIdx = params.length;
      branches.push(
        `regexp_replace(coalesce(l.phone,''),             '\\D', '', 'g') ILIKE $${digitsIdx}`,
        `regexp_replace(coalesce(l.whatsapp_number,''),   '\\D', '', 'g') ILIKE $${digitsIdx}`,
        `regexp_replace(coalesce(l.alternate_contact,''), '\\D', '', 'g') ILIKE $${digitsIdx}`,
      );
    }
    conds.push(`(${branches.join(' OR ')})`);
  }
  if (channel_id || source_id || campaign_id || medium_id) {
    const subConds = [];
    if (channel_id) { params.push(channel_id); subConds.push(`channel_id = $${params.length}`); }
    if (source_id) { params.push(source_id); subConds.push(`source_id = $${params.length}`); }
    if (campaign_id) { params.push(campaign_id); subConds.push(`campaign_id = $${params.length}`); }
    if (medium_id) { params.push(medium_id); subConds.push(`medium_id = $${params.length}`); }
    conds.push(`EXISTS (SELECT 1 FROM lead_source_attributions lsa WHERE lsa.lead_id = l.id AND ${subConds.join(' AND ')})`);
  }
  if (followup_from || followup_to) {
    // Match a followup of ANY status (planned/missed/done) whose
    // next_action_datetime lands in the window. The Follow-up Manager date
    // range often covers past dates, where the only rows are completed
    // ('done') or 'missed' attempts — restricting to 'planned' there returned
    // an empty list even though those leads clearly had followup activity.
    // A bare-date `to` bound is expanded to end-of-day so a single-day range
    // (from == to) covers the whole day instead of a single midnight instant.
    const subConds = ['lf.lead_id = l.id', 'lf.deleted_at IS NULL'];
    if (followup_from) { params.push(followup_from); subConds.push(`lf.next_action_datetime >= $${params.length}::timestamptz`); }
    if (followup_to) { params.push(followupToBound(followup_to)); subConds.push(`lf.next_action_datetime <= $${params.length}::timestamptz`); }
    conds.push(`EXISTS (SELECT 1 FROM lead_followups lf WHERE ${subConds.join(' AND ')})`);
  }
  if (is_touched === true) {
    conds.push(`EXISTS (
      SELECT 1 FROM lead_activities a WHERE a.lead_id = l.id
        AND a.type NOT IN ('lead_created','assigned','reassign','auto_assign','refer')
    )`);
  }
  if (is_touched === false) {
    conds.push(`l.assigned_to IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM lead_activities a WHERE a.lead_id = l.id
        AND a.type NOT IN ('lead_created','assigned','reassign','auto_assign','refer')
    )`);
  }
  if (includeFlag) {
    if (flag === 'unassigned') {
      conds.push(`l.assigned_to IS NULL`);
    }
    if (flag === 'fresh') {
      conds.push(`l.created_at >= now() - interval '24 hours'`);
    }
    if (flag === 'untouched') {
      conds.push(`l.assigned_to IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM lead_activities a WHERE a.lead_id = l.id
          AND a.type NOT IN ('lead_created','assigned','reassign','auto_assign','refer')
      )`);
    }
  }
  if (scope && scope.user_ids) {
    params.push(scope.user_ids);
    const userIdsIdx = params.length;
    if (scope.include_unassigned_team_id) {
      params.push(scope.include_unassigned_team_id);
      const teamIdx = params.length;
      conds.push(`(l.assigned_to = ANY($${userIdsIdx}::uuid[]) OR (l.assigned_to IS NULL AND l.team_id = $${teamIdx}))`);
    } else {
      conds.push(`l.assigned_to = ANY($${userIdsIdx}::uuid[])`);
    }
  }
  // branch_manager scope: every lead in their branch. A null branch_id means
  // the manager isn't assigned to any branch yet — scope to nothing rather
  // than leaking the whole tenant.
  if (scope && Object.prototype.hasOwnProperty.call(scope, 'branch_id')) {
    if (scope.branch_id) {
      params.push(scope.branch_id);
      conds.push(`l.branch_id = $${params.length}`);
    } else {
      conds.push('false');
    }
  }
  if (scope && scope.converted_only) {
    conds.push(`l.converted_at IS NOT NULL`);
  }
  let tagJoin = '';
  if (tag_id) {
    params.push(tag_id);
    tagJoin = `JOIN lead_tags lt ON lt.lead_id = l.id AND lt.tag_id = $${params.length}`;
  }
  return { conds, params, tagJoin };
};

export const list = async (tenant, opts, scope) => {
  const { sort, page, limit, followup_from, followup_to } = opts;
  const { conds, params, tagJoin } = buildLeadWhere(opts, scope, { includeFlag: true });
  const where = `WHERE ${conds.join(' AND ')}`;

  // The count query only ever needs the WHERE params (no limit/offset, and
  // none of the matched-followups window params added below). Snapshot it now,
  // before we append anything that's only referenced by the main SELECT.
  const countParams = [...params];

  // When the caller filtered by a follow-up date window, surface the actual
  // follow-up rows that landed in that window per lead, so the FE can show
  // *why* the lead matched (the LeadList followup filter now matches any
  // status — planned/missed/done — and most past-window matches are missed/
  // done attempts that don't otherwise appear on the collapsed card).
  // These placeholders are referenced only by the main SELECT, so they sit
  // after the WHERE params (and the count snapshot above excludes them).
  let matchedFollowupsSelect = `NULL::jsonb AS matched_followups`;
  if (followup_from || followup_to) {
    const fwConds = ['mf.lead_id = l.id', 'mf.deleted_at IS NULL'];
    if (followup_from) { params.push(followup_from); fwConds.push(`mf.next_action_datetime >= $${params.length}::timestamptz`); }
    if (followup_to) { params.push(followupToBound(followup_to)); fwConds.push(`mf.next_action_datetime <= $${params.length}::timestamptz`); }
    matchedFollowupsSelect = `
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', mf.id,
                 'next_action_datetime', mf.next_action_datetime,
                 'status', mf.status,
                 'comment', mf.comment,
                 'slot_index', mf.slot_index,
                 'stage_id', mf.stage_id,
                 -- Stage/sub-stage the follow-up was logged AGAINST (which may
                 -- differ from the lead's current stage), plus their names so
                 -- the FE can show "Missed · Followup / Warm" without a lookup.
                 'stage_name', mfs.name,
                 'sub_stage_id', mf.sub_stage_id,
                 'sub_stage_name', mfss.name
               ) ORDER BY mf.next_action_datetime)
          FROM lead_followups mf
          LEFT JOIN lead_stages     mfs  ON mfs.id  = mf.stage_id
          LEFT JOIN lead_sub_stages mfss ON mfss.id = mf.sub_stage_id
         WHERE ${fwConds.join(' AND ')}
      ), '[]'::jsonb) AS matched_followups`;
  }

  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT l.id, l.name, l.email, l.phone, l.whatsapp_number, l.stage_id, l.sub_stage_id,
              l.program_id, l.assigned_to, l.team_id, l.lead_score, l.engagement_score,
              l.is_cold, l.created_at, l.updated_at, l.last_activity_at,
              l.primary_source_id,
              s.name  AS stage_name,
              ss.name AS sub_stage_name,
              p.name  AS program_name,
              c.name  AS country_name,
              st.name AS state_name,
              ps.name AS primary_source_name,
              br.name AS branch_name,
              l.district, l.city,
              u.name   AS assigned_to_name,
              u.role   AS assigned_to_role,
              mgr.name AS manager_name,
              mgr.role AS manager_role,
              -- One level up from the direct manager (e.g. counsellor → manager → super admin).
              gmgr.name AS grand_manager_name,
              gmgr.role AS grand_manager_role,
              cb.name  AS created_by_name,
              cb.role  AS created_by_role,
              prev.name AS previous_owner_name,
              EXTRACT(EPOCH FROM (now() - l.created_at))::int / 86400 AS lead_age_days,
              -- Untouched: assigned but no human action yet (notes / calls / messages /
              -- stage-change beyond initial assign). Looks at lead_activities for
              -- types other than 'lead_created' / 'assigned' / 'reassign'.
              (l.assigned_to IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM lead_activities a
                  WHERE a.lead_id = l.id
                    AND a.type NOT IN ('lead_created', 'assigned', 'reassign', 'auto_assign', 'refer')
              )) AS is_untouched,
              -- Fresh: created within last 24h (regardless of assignment)
              (l.created_at >= now() - interval '24 hours') AS is_fresh,
              (l.converted_at IS NOT NULL) AS is_converted,
              l.converted_at,
              COALESCE((SELECT count(*)::int FROM calls cc
                          WHERE cc.lead_id = l.id AND cc.direction = 'inbound'
                            AND cc.status IN ('missed','no_answer','failed')
                            AND cc.deleted_at IS NULL), 0) AS missed_calls_count,
              COALESCE((SELECT count(*)::int FROM message_reply mr
                          WHERE mr.lead_id = l.id AND mr.is_read = false), 0) AS unread_messages_count,
              ${matchedFollowupsSelect}
         FROM leads l ${tagJoin}
         LEFT JOIN lead_stages         s   ON s.id  = l.stage_id
         LEFT JOIN lead_sub_stages     ss  ON ss.id = l.sub_stage_id
         LEFT JOIN programs            p   ON p.id  = l.program_id
         LEFT JOIN countries           c   ON c.id  = l.country_id
         LEFT JOIN states              st  ON st.id = l.state_id
         LEFT JOIN lead_primary_sources ps ON ps.id = l.primary_source_id
         LEFT JOIN users           u    ON u.id    = l.assigned_to
         LEFT JOIN users           mgr  ON mgr.id  = l.manager_id
         LEFT JOIN users           gmgr ON gmgr.id = mgr.manager_id
         LEFT JOIN users           cb  ON cb.id  = l.created_by
         LEFT JOIN branches        br  ON br.id  = l.branch_id
         LEFT JOIN LATERAL (
           SELECT u2.name FROM lead_assignments la
             JOIN users u2 ON u2.id = la.assigned_to
            WHERE la.lead_id = l.id AND la.assigned_to <> COALESCE(l.assigned_to, '00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY la.created_at DESC LIMIT 1
         ) prev ON true
         ${where}
         ORDER BY ${sortClause(sort)}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    tenantQuery(tenant, `SELECT count(*)::int AS total FROM leads l ${tagJoin} ${where}`, countParams),
  ]);
  return { rows, total: countRows[0].total };
};

// Full export — same filter/scope/sort as `list`, but with NO pagination.
// Returns every matching lead in the tenant DB with human-friendly joined
// names (stage / sub-stage / program / owner / etc.) so the CSV is readable
// without a second lookup. Used by GET /leads/export.csv (super_admin only).
//
// We deliberately reuse buildLeadWhere + sortClause so a filtered export
// (the FE passes the same filterParams it uses for the list) lines up
// exactly with what the user sees on screen — just without the LIMIT.
export const exportList = async (tenant, opts, scope) => {
  const { sort } = opts;
  const { conds, params, tagJoin } = buildLeadWhere(opts, scope, { includeFlag: true });
  const where = `WHERE ${conds.join(' AND ')}`;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT l.id, l.name, l.email, l.phone, l.whatsapp_number, l.alternate_contact,
            l.gender, l.language,
            s.name  AS stage_name,
            ss.name AS sub_stage_name,
            p.name  AS program_name,
            c.name  AS country_name,
            st.name AS state_name,
            l.district, l.city, l.pincode,
            ps.name AS primary_source_name,
            u.name   AS assigned_to_name,
            mgr.name AS manager_name,
            cb.name  AS created_by_name,
            l.lead_score, l.engagement_score, l.lead_value,
            l.is_cold,
            (l.converted_at IS NOT NULL) AS is_converted,
            l.converted_at,
            EXTRACT(EPOCH FROM (now() - l.created_at))::int / 86400 AS lead_age_days,
            l.created_at, l.updated_at, l.last_activity_at
       FROM leads l ${tagJoin}
       LEFT JOIN lead_stages          s   ON s.id  = l.stage_id
       LEFT JOIN lead_sub_stages      ss  ON ss.id = l.sub_stage_id
       LEFT JOIN programs             p   ON p.id  = l.program_id
       LEFT JOIN countries            c   ON c.id  = l.country_id
       LEFT JOIN states               st  ON st.id = l.state_id
       LEFT JOIN lead_primary_sources ps  ON ps.id = l.primary_source_id
       LEFT JOIN users                u   ON u.id  = l.assigned_to
       LEFT JOIN users                mgr ON mgr.id = l.manager_id
       LEFT JOIN users                cb  ON cb.id  = l.created_by
       ${where}
       ORDER BY ${sortClause(sort)}`,
    params,
  );
  return rows;
};

// Stage counts — scoped same way as list, and honors the same advanced
// filter so the tab labels (All / Unassigned / Fresh / Untouched / each
// stage) update when the user applies filters in the LeadList. The base
// WHERE comes from buildLeadWhere with includeFlag=false; each tab then
// appends its own predicate (e.g. "AND l.assigned_to IS NULL" for the
// Unassigned count). `opts` may be undefined for legacy callers.
export const stageCounts = async (tenant, opts = {}, scope) => {
  const { conds, params, tagJoin } = buildLeadWhere(opts, scope, { includeFlag: false });
  const where = `WHERE ${conds.join(' AND ')}`;
  // Per-stage breakdown: count leads grouped by stage. We can't reuse the
  // LEFT JOIN shape from before (group-by-stage) because the advanced
  // filter's conds reference `l.*` and depend on the JOIN being inner.
  // Easier: list all active stages, then for each stage run a count with
  // an extra `AND l.stage_id = $X`. Stages tend to be small (≤20), so the
  // extra round-trip is fine and the SQL stays straightforward.
  const { rows: stageRows } = await tenantQuery(
    tenant,
    `SELECT id, name, order_index FROM lead_stages WHERE is_active = true
      ORDER BY COALESCE(order_index, 0), name`,
  );
  const stageCountsByStage = await Promise.all(
    stageRows.map(async (s) => {
      const p = [...params, s.id];
      const { rows: r } = await tenantQuery(
        tenant,
        `SELECT COUNT(*)::int AS total FROM leads l ${tagJoin} ${where} AND l.stage_id = $${p.length}`,
        p,
      );
      return { stage_id: s.id, stage_name: s.name, order_index: s.order_index, count: r[0].total };
    }),
  );
  const totalRow = await tenantQuery(
    tenant,
    `SELECT COUNT(*)::int AS total FROM leads l ${tagJoin} ${where}`,
    params,
  );
  const untouchedRow = await tenantQuery(
    tenant,
    `SELECT COUNT(*)::int AS total FROM leads l ${tagJoin} ${where}
       AND l.assigned_to IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM lead_activities a
          WHERE a.lead_id = l.id
            AND a.type NOT IN ('lead_created', 'assigned', 'reassign', 'auto_assign', 'refer')
       )`,
    params,
  );
  const freshRow = await tenantQuery(
    tenant,
    `SELECT COUNT(*)::int AS total FROM leads l ${tagJoin} ${where} AND l.created_at >= now() - interval '24 hours'`,
    params,
  );
  const unassignedRow = await tenantQuery(
    tenant,
    `SELECT COUNT(*)::int AS total FROM leads l ${tagJoin} ${where} AND l.assigned_to IS NULL`,
    params,
  );
  return {
    all: totalRow.rows[0].total,
    fresh: freshRow.rows[0].total,
    untouched: untouchedRow.rows[0].total,
    unassigned: unassignedRow.rows[0].total,
    stages: stageCountsByStage,
  };
};

// Bulk assign: either explicit lead_ids OR all leads matching a filter.
// Side effect: any lead without a stage_id is auto-moved into the first active
// stage (lowest order_index). This matches the "Fresh → Untouched → Working"
// lifecycle and prevents leads from sitting in "no stage" once they have an owner.
export const bulkAssign = async (tenant, { lead_ids, assigned_to, assigned_by, reason, filter, scope }) => tenantTx(tenant, async (client) => {
  // INVARIANT: leads.assigned_to must be an active counsellor (managers own a
  // team, not leads). Reject a non-counsellor target before touching any lead —
  // this is what stops "reassign everything onto a branch_manager".
  const { rows: tgt } = await client.query(
    `SELECT 1 FROM users WHERE id = $1 AND role = 'counsellor' AND is_active = true AND deleted_at IS NULL`,
    [assigned_to],
  );
  if (!tgt[0]) {
    const err = new Error('Leads can only be assigned to an active counsellor');
    err.status = 403; err.code = 'FORBIDDEN'; err.isAppError = true;
    throw err;
  }
  let ids = lead_ids ?? null;
  if (!ids) {
    const conds = ['deleted_at IS NULL'];
    const params = [];
    if (filter?.stage_id) { params.push(filter.stage_id); conds.push(`stage_id = $${params.length}`); }
    if (filter?.sub_stage_id) { params.push(filter.sub_stage_id); conds.push(`sub_stage_id = $${params.length}`); }
    if (filter?.program_id) { params.push(filter.program_id); conds.push(`program_id = $${params.length}`); }
    if (filter?.assigned_to) { params.push(filter.assigned_to); conds.push(`assigned_to = $${params.length}`); }
    if (filter?.team_id) { params.push(filter.team_id); conds.push(`team_id = $${params.length}`); }
    if (filter?.q) { params.push(`%${filter.q}%`); conds.push(`(name ILIKE $${params.length} OR email::text ILIKE $${params.length} OR phone ILIKE $${params.length})`); }
    if (scope && scope.user_ids) {
      params.push(scope.user_ids);
      const userIdsIdx = params.length;
      if (scope.include_unassigned_team_id) {
        params.push(scope.include_unassigned_team_id);
        const teamIdx = params.length;
        conds.push(`(assigned_to = ANY($${userIdsIdx}::uuid[]) OR (assigned_to IS NULL AND team_id = $${teamIdx}))`);
      } else {
        conds.push(`assigned_to = ANY($${userIdsIdx}::uuid[])`);
      }
    }
    if (scope && scope.converted_only) { conds.push(`converted_at IS NOT NULL`); }
    const r = await client.query(`SELECT id FROM leads WHERE ${conds.join(' AND ')}`, params);
    ids = r.rows.map((x) => x.id);
  }
  if (!ids.length) return { affected: 0, ids: [] };

  // Resolve the first active stage once (used to fill in null-stage leads).
  const firstStageRes = await client.query(`SELECT id FROM lead_stages WHERE is_active = true ORDER BY order_index ASC, name ASC LIMIT 1`);
  const firstStageId = firstStageRes.rows[0]?.id ?? null;

  // Resolve the assignee's manager + branch (snapshotted onto each lead).
  const mgrRes = await client.query(`SELECT manager_id, branch_id FROM users WHERE id = $1`, [assigned_to]);
  const newManagerId = mgrRes.rows[0]?.manager_id ?? null;
  const newBranchId = mgrRes.rows[0]?.branch_id ?? null;

  // Snapshot each lead's current owner BEFORE we overwrite it, so we can
  // record `from_user_id` on the new assignment row. Without this, the
  // ownership-history "previous → current" chain renders blank for every
  // bulk reassignment (the single-lead path at lead-assignments/routes.js
  // already captures from_user_id; this matches it).
  const priorRes = await client.query(
    `SELECT id, assigned_to FROM leads WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [ids],
  );
  const priorOwnerByLead = new Map(priorRes.rows.map((r) => [r.id, r.assigned_to]));

  // Only the leads that actually change owner. Skipping no-op reassignments
  // (lead already owned by the target) keeps us from churning the active
  // assignment row, deactivating it, and writing a misleading from===to
  // history row + spurious timeline event.
  const changingIds = priorRes.rows
    .filter((r) => r.assigned_to !== assigned_to)
    .map((r) => r.id);
  if (!changingIds.length) return { affected: 0, ids: [] };

  await client.query(
    `UPDATE leads
        SET assigned_to     = $1,
            manager_id      = $4,
            branch_id       = $5,
            stage_id        = COALESCE(stage_id, $3),
            updated_at      = now(),
            last_activity_at = now()
      WHERE id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [assigned_to, changingIds, firstStageId, newManagerId, newBranchId],
  );
  await client.query(`UPDATE lead_assignments SET is_active = false, status = 'closed' WHERE lead_id = ANY($1::uuid[]) AND is_active`, [changingIds]);
  for (const id of changingIds) {
    const fromUserId = priorOwnerByLead.get(id) ?? null;
    // clock_timestamp() (not the txn-frozen now()) so each row in this loop
    // gets a distinct, monotonic created_at. With the default now(), every
    // bulk row shares one timestamp and the timeline's "ORDER BY created_at"
    // ties — making a newer event appear older than an earlier one.
    await client.query(
      `INSERT INTO lead_assignments (lead_id, from_user_id, assigned_to, assigned_by, assignment_type, reason, is_active, status, created_at)
       VALUES ($1,$2,$3,$4,'reassign',$5,true,'open', clock_timestamp())`,
      [id, fromUserId, assigned_to, assigned_by ?? null, reason ?? null],
    );
    await client.query(
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json, created_at)
       VALUES ($1,$2,'reassign',$3,$4::jsonb, clock_timestamp())`,
      [id, assigned_by ?? null, 'Lead reassigned', JSON.stringify({ from: fromUserId, to: assigned_to, assigned_to, reason: reason ?? null })],
    );
  }
  return { affected: changingIds.length, ids: changingIds };
});
