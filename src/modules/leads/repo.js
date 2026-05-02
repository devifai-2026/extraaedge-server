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
  // Main lead row
  const cols = [];
  const vals = [];
  const placeholders = [];
  let i = 1;
  for (const [k, v] of Object.entries(input)) {
    if (['family', 'custom_values', 'sources'].includes(k)) continue;
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

  // Lead assignment history row if assigned
  if (input.assigned_to) {
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

  return lead;
});

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
};

export const findByIdWithRelations = async (tenant, id) => {
  const base = await findById(tenant, id);
  if (!base) return null;
  const [family, sources, tagsRes, customValuesRes] = await Promise.all([
    tenantQuery(tenant, `SELECT * FROM lead_family WHERE lead_id = $1`, [id]),
    tenantQuery(tenant, `SELECT * FROM lead_source_attributions WHERE lead_id = $1 ORDER BY is_primary DESC, captured_at`, [id]),
    tenantQuery(tenant, `SELECT t.id, t.name, t.color FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = $1 AND t.deleted_at IS NULL`, [id]),
    tenantQuery(tenant, `
      SELECT d.key, d.label, d.field_type, v.value
        FROM lead_custom_values v
        JOIN custom_field_definitions d ON d.id = v.field_id
       WHERE v.lead_id = $1 AND d.deleted_at IS NULL
    `, [id]),
  ]);
  const custom_values = {};
  for (const r of customValuesRes.rows) custom_values[r.key] = r.value;
  return {
    ...base,
    family: family.rows[0] ?? null,
    sources: sources.rows,
    tags: tagsRes.rows,
    custom_values,
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

export const changeStage = async (tenant, id, { stage_id, sub_stage_id, remarks }, user_id) => tenantTx(tenant, async (client) => {
  const { rows: oldRows } = await client.query(`SELECT stage_id, sub_stage_id FROM leads WHERE id = $1 AND deleted_at IS NULL`, [id]);
  const old = oldRows[0];
  if (!old) return null;
  await client.query(
    `UPDATE leads SET stage_id = $2, sub_stage_id = $3, remarks = COALESCE($4, remarks), last_activity_at = now() WHERE id = $1`,
    [id, stage_id, sub_stage_id ?? null, remarks ?? null],
  );
  await client.query(
    `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
     VALUES ($1,$2,'stage_changed',$3,$4::jsonb)`,
    [id, user_id ?? null, `Stage changed`, JSON.stringify({ from: old.stage_id, to: stage_id, from_sub: old.sub_stage_id, to_sub: sub_stage_id ?? null })],
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

export const list = async (tenant, { q, stage_id, sub_stage_id, program_id, assigned_to, team_id, tag_id, date_from, date_to, sort, page, limit }, scope) => {
  const conds = ['l.deleted_at IS NULL'];
  const params = [];
  if (stage_id) { params.push(stage_id); conds.push(`l.stage_id = $${params.length}`); }
  if (sub_stage_id) { params.push(sub_stage_id); conds.push(`l.sub_stage_id = $${params.length}`); }
  if (program_id) { params.push(program_id); conds.push(`l.program_id = $${params.length}`); }
  if (assigned_to) { params.push(assigned_to); conds.push(`l.assigned_to = $${params.length}`); }
  if (team_id) { params.push(team_id); conds.push(`l.team_id = $${params.length}`); }
  if (date_from) { params.push(date_from); conds.push(`l.created_at >= $${params.length}::timestamptz`); }
  if (date_to) { params.push(date_to); conds.push(`l.created_at <= $${params.length}::timestamptz`); }
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(l.name ILIKE $${params.length} OR l.email::text ILIKE $${params.length} OR l.phone ILIKE $${params.length})`);
  }
  if (scope && scope.user_ids) {
    params.push(scope.user_ids);
    conds.push(`l.assigned_to = ANY($${params.length}::uuid[])`);
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
              l.is_cold, l.created_at, l.updated_at, l.last_activity_at
         FROM leads l ${tagJoin}
         ${where}
         ORDER BY ${sortClause(sort)}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    tenantQuery(tenant, `SELECT count(*)::int AS total FROM leads l ${tagJoin} ${where}`, countParams),
  ]);
  return { rows, total: countRows[0].total };
};
