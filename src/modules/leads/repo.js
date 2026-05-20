import { tenantQuery, tenantTx } from '../../db/tenant.js';

export const LEAD_COLUMNS = `
  id, name, first_name, last_name, alternate_first_name, email, alternate_email,
  phone, whatsapp_number, alternate_contact, gender, language,
  ug_degree_id, ug_specialization_id, ug_university_id, ug_graduation_year,
  pg_degree_id, pg_specialization_id, pg_university_id, pg_graduation_year,
  country_id, state_id, district, city, address, pincode,
  program_id, stage_id, sub_stage_id, remarks, closure_remarks,
  assigned_to, team_id, created_by,
  lead_score, lead_score_manual_override, engagement_score, lead_value,
  referred_by_lead_id, referral_code_used, referral_source,
  first_touch_campaign_id, first_touch_channel, first_touch_source, first_touch_medium, first_touch_at,
  last_touch_campaign_id, last_touch_channel, last_touch_source, last_touch_medium, last_touch_at,
  mobile_verified_at, email_verified_at, is_cold,
  converted_at, merged_into_id,
  primary_source_id,
  created_at, updated_at, last_activity_at
`;

// Duplicate detection by exact phone/email/whatsapp match (case-insensitive).
export const findDuplicates = async (tenant, { phone, email, whatsapp_number }, { excludeId } = {}) => {
  const conds = [];
  const params = [];
  if (phone) { params.push(phone); conds.push(`phone = $${params.length}`); }
  if (email) { params.push(email); conds.push(`lower(email::text) = lower($${params.length}::text)`); }
  if (whatsapp_number) { params.push(whatsapp_number); conds.push(`whatsapp_number = $${params.length}`); }
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

  // Source attributions
  if (input.sources && input.sources.length) {
    for (const [idx, s] of input.sources.entries()) {
      await client.query(
        `INSERT INTO lead_source_attributions (lead_id, channel_id, source_id, campaign_id, medium_id, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [lead.id, s.channel_id ?? null, s.source_id ?? null, s.campaign_id ?? null, s.medium_id ?? null, s.is_primary ?? idx === 0],
      );
    }
  }

  // Lead assignment history row if assigned. Also snap manager_id from the
  // assignee's primary manager so the LeadCard hierarchy chip + manager
  // leadlist filter are correct from the moment the row exists. The same
  // snapping happens on auto-assign (rule-processor) and manual reassign
  // (lead-assignments routes); keeping it here closes the create path.
  if (input.assigned_to) {
    const { rows: mgrRows } = await client.query(
      `SELECT manager_id FROM users WHERE id = $1`,
      [input.assigned_to],
    );
    const newManagerId = mgrRows[0]?.manager_id ?? null;
    await client.query(
      `UPDATE leads SET manager_id = $2 WHERE id = $1`,
      [lead.id, newManagerId],
    );
    lead.manager_id = newManagerId;
    await client.query(
      `INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, assignment_type, is_active, status)
       VALUES ($1,$2,$3,'assign',true,'open')`,
      [lead.id, input.assigned_to, created_by],
    );
  }

  // Initial activity
  await client.query(
    `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
     VALUES ($1,$2,'lead_created','Lead created',$3::jsonb)`,
    [lead.id, created_by ?? null, JSON.stringify({ source: 'api' })],
  );

  // If the form pre-assigned an owner, the timeline should also show an
  // 'assign' event so the "Counselor Activity" filter on the lead drawer
  // sees it (mirrors the auto_assign row dropped by the worker).
  if (input.assigned_to) {
    await client.query(
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1,$2,'assign','Assigned on creation',$3::jsonb)`,
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

export const updateLead = async (tenant, id, updates) => tenantTx(tenant, async (client) => {
  const fields = [];
  const params = [];
  let i = 1;
  const { family, custom_values, sources, ...scalar } = updates;
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
    // Replace source attributions (destructive; treat UI as authoritative for this array)
    await client.query(`DELETE FROM lead_source_attributions WHERE lead_id = $1`, [id]);
    for (const [idx, s] of sources.entries()) {
      await client.query(
        `INSERT INTO lead_source_attributions (lead_id, channel_id, source_id, campaign_id, medium_id, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, s.channel_id ?? null, s.source_id ?? null, s.campaign_id ?? null, s.medium_id ?? null, s.is_primary ?? idx === 0],
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
      if (!r?.next_action_datetime) continue;
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
      const status = r.status ?? 'done';
      const completedAt = status === 'done' ? r.next_action_datetime : null;
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
          [r.next_action_datetime, r.comment ?? null, status, subStageId,
           completedAt, completedAt ? actor_id ?? null : null, existingId],
        );
      } else {
        await client.query(
          `INSERT INTO lead_followups
              (lead_id, next_action_datetime, comment, status, created_by,
               completed_at, completed_by, slot_index, stage_id, sub_stage_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [lead_id, r.next_action_datetime, r.comment ?? null, status,
           actor_id ?? null, completedAt,
           completedAt ? actor_id ?? null : null, slot, stage_id, subStageId],
        );
      }
      written += 1;
    }
    return { written };
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
    case 'score_desc': return 'l.lead_score DESC, l.created_at DESC';
    case 'last_activity_desc': return 'l.last_activity_at DESC';
    default: return 'l.created_at DESC';
  }
};

export const list = async (tenant, opts, scope) => {
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
    date_from, date_to, sort, page, limit, flag,
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
  if (lead_age_from != null) { params.push(lead_age_from); conds.push(`EXTRACT(EPOCH FROM (now() - l.created_at)) / 86400 >= $${params.length}`); }
  if (lead_age_to != null) { params.push(lead_age_to); conds.push(`EXTRACT(EPOCH FROM (now() - l.created_at)) / 86400 <= $${params.length}`); }
  if (lead_score_from != null) { params.push(lead_score_from); conds.push(`l.lead_score >= $${params.length}`); }
  if (lead_score_to != null) { params.push(lead_score_to); conds.push(`l.lead_score <= $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(l.name ILIKE $${params.length} OR l.email::text ILIKE $${params.length} OR l.phone ILIKE $${params.length})`);
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
    const subConds = ['lf.lead_id = l.id', 'lf.deleted_at IS NULL', "lf.status = 'planned'"];
    if (followup_from) { params.push(followup_from); subConds.push(`lf.next_action_datetime >= $${params.length}::timestamptz`); }
    if (followup_to) { params.push(followup_to); subConds.push(`lf.next_action_datetime <= $${params.length}::timestamptz`); }
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
  if (scope && scope.user_ids) {
    params.push(scope.user_ids);
    conds.push(`l.assigned_to = ANY($${params.length}::uuid[])`);
  }
  // account_manager scope: see every converted lead across the tenant,
  // ignore owner. Set by computeScope() in leads/service.js.
  if (scope && scope.converted_only) {
    conds.push(`l.converted_at IS NOT NULL`);
  }
  let tagJoin = '';
  if (tag_id) {
    params.push(tag_id);
    tagJoin = `JOIN lead_tags lt ON lt.lead_id = l.id AND lt.tag_id = $${params.length}`;
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const countParams = params.slice(0, -2);
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
                          WHERE mr.lead_id = l.id AND mr.is_read = false), 0) AS unread_messages_count
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

// Stage counts — scoped same way as list. Returns one row per stage incl. unstaged.
export const stageCounts = async (tenant, scope) => {
  const params = [];
  const conds = ['l.deleted_at IS NULL'];
  if (scope && scope.user_ids) {
    params.push(scope.user_ids);
    conds.push(`l.assigned_to = ANY($${params.length}::uuid[])`);
  }
  // account_manager: limit to converted leads.
  if (scope && scope.converted_only) {
    conds.push(`l.converted_at IS NOT NULL`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id AS stage_id, s.name AS stage_name, s.order_index,
            COUNT(l.id)::int AS count
       FROM lead_stages s
       LEFT JOIN leads l ON l.stage_id = s.id AND l.deleted_at IS NULL
            ${scope && scope.user_ids ? `AND l.assigned_to = ANY($1::uuid[])` : ''}
            ${scope && scope.converted_only ? `AND l.converted_at IS NOT NULL` : ''}
      WHERE s.is_active = true
      GROUP BY s.id, s.name, s.order_index
      ORDER BY COALESCE(s.order_index, 0), s.name`,
    params,
  );
  const totalRow = await tenantQuery(tenant, `SELECT COUNT(*)::int AS total FROM leads l ${where}`, params);
  const untouchedRow = await tenantQuery(
    tenant,
    `SELECT COUNT(*)::int AS total FROM leads l ${where}
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
    `SELECT COUNT(*)::int AS total FROM leads l ${where} AND l.created_at >= now() - interval '24 hours'`,
    params,
  );
  const unassignedRow = await tenantQuery(
    tenant,
    `SELECT COUNT(*)::int AS total FROM leads l ${where} AND l.assigned_to IS NULL`,
    params,
  );
  return {
    all: totalRow.rows[0].total,
    fresh: freshRow.rows[0].total,
    untouched: untouchedRow.rows[0].total,
    unassigned: unassignedRow.rows[0].total,
    stages: rows,
  };
};

// Bulk assign: either explicit lead_ids OR all leads matching a filter.
// Side effect: any lead without a stage_id is auto-moved into the first active
// stage (lowest order_index). This matches the "Fresh → Untouched → Working"
// lifecycle and prevents leads from sitting in "no stage" once they have an owner.
export const bulkAssign = async (tenant, { lead_ids, assigned_to, assigned_by, reason, filter, scope }) => tenantTx(tenant, async (client) => {
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
    if (scope && scope.user_ids) { params.push(scope.user_ids); conds.push(`assigned_to = ANY($${params.length}::uuid[])`); }
    if (scope && scope.converted_only) { conds.push(`converted_at IS NOT NULL`); }
    const r = await client.query(`SELECT id FROM leads WHERE ${conds.join(' AND ')}`, params);
    ids = r.rows.map((x) => x.id);
  }
  if (!ids.length) return { affected: 0, ids: [] };

  // Resolve the first active stage once (used to fill in null-stage leads).
  const firstStageRes = await client.query(`SELECT id FROM lead_stages WHERE is_active = true ORDER BY order_index ASC, name ASC LIMIT 1`);
  const firstStageId = firstStageRes.rows[0]?.id ?? null;

  // Resolve the assignee's manager (if they're a counsellor under one).
  const mgrRes = await client.query(`SELECT manager_id FROM users WHERE id = $1`, [assigned_to]);
  const newManagerId = mgrRes.rows[0]?.manager_id ?? null;

  await client.query(
    `UPDATE leads
        SET assigned_to     = $1,
            manager_id      = $4,
            stage_id        = COALESCE(stage_id, $3),
            updated_at      = now(),
            last_activity_at = now()
      WHERE id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [assigned_to, ids, firstStageId, newManagerId],
  );
  await client.query(`UPDATE lead_assignments SET is_active = false WHERE lead_id = ANY($1::uuid[])`, [ids]);
  for (const id of ids) {
    await client.query(
      `INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, assignment_type, reason, is_active, status)
       VALUES ($1,$2,$3,'reassign',$4,true,'open')`,
      [id, assigned_to, assigned_by ?? null, reason ?? null],
    );
    await client.query(
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1,$2,'assigned',$3,$4::jsonb)`,
      [id, assigned_by ?? null, 'Lead reassigned', JSON.stringify({ assigned_to, reason: reason ?? null })],
    );
  }
  return { affected: ids.length, ids };
});
