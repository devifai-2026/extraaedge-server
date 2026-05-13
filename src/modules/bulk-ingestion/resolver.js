// Resolves human-readable dropdown values from a bulk-import row into
// the FK columns the `leads` table expects.
//
// Two policies per field:
//   STRICT     — value must exist; missing → row fails with a clean message.
//                Used for stage / sub_stage / country (small, CRM-managed).
//   AUTO_CREATE — missing values are inserted into the dropdown table.
//                 Used for program / state / universities / specializations
//                 / degrees / channel / source / campaign / medium.
//
// A single `createCache(tenant)` instance should be shared across every row
// of one import — that way each dropdown is read at most once per job, and
// auto-created values are immediately reusable by later rows.
//
// Match is case- and whitespace-insensitive ("IIT Delhi" == "iit delhi"),
// but inserted rows keep the user's original casing.
import { tenantQuery } from '../../db/tenant.js';

const norm = (s) => (s ?? '').toString().trim().toLowerCase().replace(/\s+/gu, ' ');
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';

// Each dropdown gets one Map from normalized name -> uuid. We populate
// lazily on first lookup of that field.
export const createCache = () => ({
  loaded: new Set(),
  data: {
    stage: new Map(),                   // name -> id
    sub_stage_by_stage: new Map(),      // `${stage_id}::${name}` -> id
    stages_with_sub: new Set(),         // stage_ids that have at least one sub-stage
    country: new Map(),
    state_by_country: new Map(),        // `${country_id}::${name}` -> id
    program: new Map(),
    universities: new Map(),
    specializations: new Map(),
    degrees_ug: new Map(),
    degrees_pg: new Map(),
    channel: new Map(),
    source: new Map(),
    campaign: new Map(),
    medium: new Map(),
  },
});

// ----- Loaders. Read-once per job. -----
const ensureLoaded = async (tenant, cache, key, sql, intoMap) => {
  if (cache.loaded.has(key)) return;
  const { rows } = await tenantQuery(tenant, sql);
  for (const r of rows) intoMap(r);
  cache.loaded.add(key);
};

// lead_stages has both `name` ("New") and `code` ("01-New"). The bulk-upload
// dialog sends defaults using the code ("01-New") so we match against both.
const loadStages = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'stage', `SELECT id, name, code FROM lead_stages WHERE deleted_at IS NULL`,
    (r) => {
      cache.data.stage.set(norm(r.name), r.id);
      if (r.code) cache.data.stage.set(norm(r.code), r.id);
    });

const loadSubStages = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'sub_stage', `SELECT id, name, stage_id FROM lead_sub_stages WHERE deleted_at IS NULL`,
    (r) => {
      cache.data.sub_stage_by_stage.set(`${r.stage_id}::${norm(r.name)}`, r.id);
      cache.data.stages_with_sub.add(r.stage_id);
    });

const loadCountries = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'country', `SELECT id, name FROM countries WHERE deleted_at IS NULL`,
    (r) => cache.data.country.set(norm(r.name), r.id));

const loadStates = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'state', `SELECT id, name, country_id FROM states WHERE deleted_at IS NULL`,
    (r) => cache.data.state_by_country.set(`${r.country_id}::${norm(r.name)}`, r.id));

const loadPrograms = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'program', `SELECT id, name FROM programs WHERE deleted_at IS NULL`,
    (r) => cache.data.program.set(norm(r.name), r.id));

const loadUniversities = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'universities', `SELECT id, name FROM universities WHERE deleted_at IS NULL`,
    (r) => cache.data.universities.set(norm(r.name), r.id));

const loadSpecializations = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'specializations', `SELECT id, name FROM specializations WHERE deleted_at IS NULL`,
    (r) => cache.data.specializations.set(norm(r.name), r.id));

const loadDegrees = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'degrees', `SELECT id, name, level FROM degrees WHERE deleted_at IS NULL`,
    (r) => {
      const target = r.level === 'UG' ? cache.data.degrees_ug : r.level === 'PG' ? cache.data.degrees_pg : null;
      if (target) target.set(norm(r.name), r.id);
    });

const loadChannels = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'channel', `SELECT id, name FROM lead_channels WHERE deleted_at IS NULL`,
    (r) => cache.data.channel.set(norm(r.name), r.id));

const loadSources = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'source', `SELECT id, name FROM lead_sources_dict WHERE deleted_at IS NULL`,
    (r) => cache.data.source.set(norm(r.name), r.id));

const loadCampaigns = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'campaign', `SELECT id, name FROM lead_campaigns_dict WHERE deleted_at IS NULL`,
    (r) => cache.data.campaign.set(norm(r.name), r.id));

const loadMediums = (tenant, cache) =>
  ensureLoaded(tenant, cache, 'medium', `SELECT id, name FROM lead_mediums WHERE deleted_at IS NULL`,
    (r) => cache.data.medium.set(norm(r.name), r.id));

// ----- Auto-create helpers. ON CONFLICT covers concurrent-job races. -----
const autoCreateSingle = async (tenant, table, name) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO ${table} (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name],
  );
  return rows[0].id;
};

const autoCreateState = async (tenant, country_id, name) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO states (country_id, name) VALUES ($1, $2)
     ON CONFLICT (country_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [country_id, name],
  );
  return rows[0].id;
};

const autoCreateDegree = async (tenant, level, name) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO degrees (level, name) VALUES ($1, $2)
     ON CONFLICT (level, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [level, name],
  );
  return rows[0].id;
};

const autoCreateProgram = async (tenant, name) => {
  // programs.code is UNIQUE but nullable; programs.name is not unique. So
  // we have to check first and only insert when missing. Two concurrent
  // imports could race here — extremely unlikely for the same fresh program
  // name, and the worst case is a duplicate row that the operator can merge.
  const { rows: existing } = await tenantQuery(
    tenant,
    `SELECT id FROM programs WHERE lower(name) = lower($1) AND deleted_at IS NULL LIMIT 1`,
    [name],
  );
  if (existing[0]) return existing[0].id;
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO programs (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return rows[0].id;
};

// ----- Main resolver. Returns { ok, resolved } or { ok: false, error }. -----
export const resolveDropdowns = async (tenant, row, cache) => {
  const out = { ...row };
  const fail = (code, message) => ({ ok: false, error: { code, message } });

  // ---- STAGE (strict) ----
  if (!isEmpty(out.stage)) {
    await loadStages(tenant, cache);
    const id = cache.data.stage.get(norm(out.stage));
    if (!id) return fail('STAGE_NOT_FOUND', `Stage "${out.stage}" not found — add it under Settings → Dropdowns → Stages first`);
    out.stage_id = id;
  }
  delete out.stage;

  // ---- SUB-STAGE ----
  // Required ONLY when the chosen stage has at least one sub-stage configured.
  // Stages with no sub-stages may leave it blank. If provided, it must match
  // a sub-stage that belongs to the chosen stage.
  await loadSubStages(tenant, cache);
  if (!isEmpty(out.sub_stage)) {
    if (!out.stage_id) return fail('SUBSTAGE_WITHOUT_STAGE', `Sub-stage "${out.sub_stage}" provided but no stage was set`);
    const id = cache.data.sub_stage_by_stage.get(`${out.stage_id}::${norm(out.sub_stage)}`);
    if (!id) return fail('SUBSTAGE_MISMATCH', `Sub-stage "${out.sub_stage}" does not belong to the chosen stage`);
    out.sub_stage_id = id;
  } else if (out.stage_id && cache.data.stages_with_sub.has(out.stage_id)) {
    return fail('MISSING_SUBSTAGE', 'Sub-stage is required for this stage (the stage has sub-stages configured)');
  }
  delete out.sub_stage;

  // ---- COUNTRY (strict) ----
  if (!isEmpty(out.country)) {
    await loadCountries(tenant, cache);
    const id = cache.data.country.get(norm(out.country));
    if (!id) return fail('COUNTRY_NOT_FOUND', `Country "${out.country}" not found — add it under Settings → Dropdowns → Countries first`);
    out.country_id = id;
  }
  delete out.country;

  // ---- STATE (auto-create, requires country) ----
  if (!isEmpty(out.state)) {
    if (!out.country_id) return fail('STATE_NEEDS_COUNTRY', `State "${out.state}" provided but no valid country was set`);
    await loadStates(tenant, cache);
    const cacheKey = `${out.country_id}::${norm(out.state)}`;
    let id = cache.data.state_by_country.get(cacheKey);
    if (!id) {
      id = await autoCreateState(tenant, out.country_id, String(out.state).trim());
      cache.data.state_by_country.set(cacheKey, id);
    }
    out.state_id = id;
  }
  delete out.state;

  // ---- PROGRAM (auto-create) ----
  if (!isEmpty(out.program)) {
    await loadPrograms(tenant, cache);
    const k = norm(out.program);
    let id = cache.data.program.get(k);
    if (!id) {
      id = await autoCreateProgram(tenant, String(out.program).trim());
      cache.data.program.set(k, id);
    }
    out.program_id = id;
  }
  delete out.program;

  // ---- UG / PG: degree (auto-create), specialization (auto-create), university (auto-create) ----
  for (const level of ['ug', 'pg']) {
    const degKey = `${level}_degree`;
    const specKey = `${level}_specialization`;
    const uniKey = `${level}_university`;

    if (!isEmpty(out[degKey])) {
      await loadDegrees(tenant, cache);
      const targetMap = level === 'ug' ? cache.data.degrees_ug : cache.data.degrees_pg;
      const k = norm(out[degKey]);
      let id = targetMap.get(k);
      if (!id) {
        id = await autoCreateDegree(tenant, level.toUpperCase(), String(out[degKey]).trim());
        targetMap.set(k, id);
      }
      out[`${degKey}_id`] = id;
    }
    delete out[degKey];

    if (!isEmpty(out[specKey])) {
      await loadSpecializations(tenant, cache);
      const k = norm(out[specKey]);
      let id = cache.data.specializations.get(k);
      if (!id) {
        id = await autoCreateSingle(tenant, 'specializations', String(out[specKey]).trim());
        cache.data.specializations.set(k, id);
      }
      out[`${specKey}_id`] = id;
    }
    delete out[specKey];

    if (!isEmpty(out[uniKey])) {
      await loadUniversities(tenant, cache);
      const k = norm(out[uniKey]);
      let id = cache.data.universities.get(k);
      if (!id) {
        id = await autoCreateSingle(tenant, 'universities', String(out[uniKey]).trim());
        cache.data.universities.set(k, id);
      }
      out[`${uniKey}_id`] = id;
    }
    delete out[uniKey];
  }

  // ---- Marketing dimensions (auto-create) — these are NOT FKs on `leads`,
  // they live on lead_source_attributions. So we resolve them but stash the
  // ids in a sub-object the worker can use to build a sources[] array. ----
  const sourceAttribution = {};
  for (const [field, table, mapKey] of [
    ['channel', 'lead_channels', 'channel'],
    ['source', 'lead_sources_dict', 'source'],
    ['campaign', 'lead_campaigns_dict', 'campaign'],
    ['medium', 'lead_mediums', 'medium'],
  ]) {
    if (!isEmpty(out[field])) {
      const loader = { channel: loadChannels, source: loadSources, campaign: loadCampaigns, medium: loadMediums }[mapKey];
      await loader(tenant, cache);
      const k = norm(out[field]);
      let id = cache.data[mapKey].get(k);
      if (!id) {
        id = await autoCreateSingle(tenant, table, String(out[field]).trim());
        cache.data[mapKey].set(k, id);
      }
      sourceAttribution[`${mapKey}_id`] = id;
      // Also store first_touch_* on the lead row itself (these are denormalized
      // copies of the marketing attribution that already exist as columns).
      out[`first_touch_${mapKey === 'campaign' ? 'campaign_id' : mapKey}`] = mapKey === 'campaign' ? id : String(out[field]).trim();
    }
    delete out[field];
  }
  // Wire up the lead_source_attributions row that insertLead understands.
  if (Object.keys(sourceAttribution).length) {
    out.sources = [{ ...sourceAttribution, is_primary: true }];
  }

  return { ok: true, resolved: out };
};
