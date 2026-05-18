import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { getDownloadSignedUrl } from '../lib/r2.js';
import { parseSpreadsheetBuffer } from '../lib/csv.js';
import { findDuplicates, insertLead } from '../modules/leads/repo.js';
import { autoAssignUnassigned } from '../modules/leads/service.js';
import { resolveDropdowns, createCache } from '../modules/bulk-ingestion/resolver.js';
import { logger } from '../lib/logger.js';

const fetchByKey = async (key) => {
  const url = await getDownloadSignedUrl({ key, expiresIn: 60 });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download upload: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const applyMapping = (row, mapping, defaults) => {
  const out = { ...defaults };
  const hasExplicitMapping = mapping && Object.keys(mapping).length > 0;
  if (hasExplicitMapping) {
    // Old path: UI provided a sheet-column → CRM-field mapping.
    for (const [src, tgt] of Object.entries(mapping)) {
      if (row[src] !== undefined && row[src] !== '') out[tgt] = row[src];
    }
  } else {
    // New path (no UI mapper): pass every non-empty column through using
    // its header as the field name. The downloaded template's headers
    // already match the CRM field names, so this is identity.
    for (const [k, v] of Object.entries(row)) {
      if (v !== undefined && v !== '') out[k] = v;
    }
  }
  return out;
};

// Per-row validation. Returns { ok: true, normalized } or
// { ok: false, error: { code, message } }. The normalized object trims
// strings and lowercases the email so duplicate detection is reliable.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// Accepts +91xxxxxxxxxx, 91xxxxxxxxxx, or 10-digit mobile numbers. The
// bulk-lead template documents +CC format but real-world uploads are messy,
// so we accept more shapes and normalize.
const normalizePhone = (raw) => {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d+]/gu, '');
  if (!digits) return '';
  // Strip leading + for length check
  const noPlus = digits.replace(/^\+/u, '');
  if (noPlus.length < 10 || noPlus.length > 15) return null; // signal invalid
  return digits.startsWith('+') ? digits : `+${noPlus.length === 10 ? '91' + noPlus : noPlus}`;
};

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

const validateRow = (mapped) => {
  // Row-level requirements:
  //   • Identity: at least one of email / first_name / last_name
  //   • Contact:  at least one of whatsapp_number / phone
  //   • Stage:    required (sub_stage is enforced later by the resolver,
  //               which knows whether the chosen stage has any sub-stages —
  //               stages with none configured are allowed to leave it blank)
  const hasIdentity = !isBlank(mapped.email) || !isBlank(mapped.first_name) || !isBlank(mapped.last_name) || !isBlank(mapped.name);
  if (!hasIdentity) {
    return { ok: false, error: { code: 'MISSING_IDENTITY', message: 'At least one of email, first_name, or last_name is required' } };
  }
  const hasContact = !isBlank(mapped.whatsapp_number) || !isBlank(mapped.phone);
  if (!hasContact) {
    return { ok: false, error: { code: 'MISSING_CONTACT', message: 'At least one of whatsapp_number or phone is required' } };
  }
  if (isBlank(mapped.stage) && isBlank(mapped.stage_id)) {
    return { ok: false, error: { code: 'MISSING_STAGE', message: 'Stage is required' } };
  }

  // Email format (only if present).
  if (mapped.email && !EMAIL_RE.test(String(mapped.email).trim())) {
    return { ok: false, error: { code: 'INVALID_EMAIL', message: `Email "${mapped.email}" is not a valid email address` } };
  }
  if (mapped.alternate_email && !EMAIL_RE.test(String(mapped.alternate_email).trim())) {
    return { ok: false, error: { code: 'INVALID_ALTERNATE_EMAIL', message: `Alternate email "${mapped.alternate_email}" is not a valid email address` } };
  }

  // Phone format. Normalize and check; null return means invalid shape.
  const phone = normalizePhone(mapped.phone);
  if (mapped.phone && phone === null) {
    return { ok: false, error: { code: 'INVALID_PHONE', message: `Phone "${mapped.phone}" is not a valid phone number` } };
  }
  const wa = normalizePhone(mapped.whatsapp_number);
  if (mapped.whatsapp_number && wa === null) {
    return { ok: false, error: { code: 'INVALID_WHATSAPP', message: `WhatsApp number "${mapped.whatsapp_number}" is not a valid phone number` } };
  }

  // Graduation year sanity (only if present and numeric-ish).
  for (const yearKey of ['ug_graduation_year', 'pg_graduation_year']) {
    if (mapped[yearKey]) {
      const y = Number(mapped[yearKey]);
      if (!Number.isFinite(y) || y < 1950 || y > 2100) {
        return { ok: false, error: { code: 'INVALID_YEAR', message: `${yearKey} "${mapped[yearKey]}" is not a valid year` } };
      }
    }
  }

  // Derive `name` from first_name / last_name when the sheet doesn't have a
  // standalone `name` column. Both present → "first last"; one present →
  // that one; neither → null (the leads.name column allows null).
  const trim = (v) => (isBlank(v) ? '' : String(v).trim());
  const first = trim(mapped.first_name);
  const last = trim(mapped.last_name);
  const existing = trim(mapped.name);
  const composed = existing || [first, last].filter(Boolean).join(' ');
  const name = composed || null;

  return {
    ok: true,
    normalized: {
      ...mapped,
      name,
      email: mapped.email ? String(mapped.email).trim().toLowerCase() : mapped.email,
      phone: phone || mapped.phone,
      whatsapp_number: wa || mapped.whatsapp_number,
    },
  };
};

// Pick the first matching field that triggered the duplicate, for the
// `match_field` column on bulk_import_duplicates.
const matchedFieldFor = (mapped, dup) => {
  if (mapped.email && dup.email && String(mapped.email).toLowerCase() === String(dup.email).toLowerCase()) {
    return { field: 'email', value: mapped.email };
  }
  if (mapped.phone && dup.phone && mapped.phone === dup.phone) {
    return { field: 'phone', value: mapped.phone };
  }
  if (mapped.whatsapp_number && dup.whatsapp_number && mapped.whatsapp_number === dup.whatsapp_number) {
    return { field: 'whatsapp_number', value: mapped.whatsapp_number };
  }
  // Fallback — should be rare, since findDuplicates already matched on one of the three.
  return { field: 'phone', value: mapped.phone || mapped.email || mapped.whatsapp_number || '' };
};

// Strip the resolved row down to the columns insertLead/insertLead's
// schema actually understands. Anything outside this list is silently
// ignored — that means tags, assigned_to_email, etc. won't be stored
// today, but it keeps the bulk path matching the Add Lead UI's payload
// shape and avoids "column ... does not exist" errors when sheet
// columns map to no real DB column.
const LEAD_COLS = new Set([
  'name', 'first_name', 'last_name', 'alternate_first_name',
  'email', 'alternate_email', 'phone', 'whatsapp_number', 'alternate_contact',
  'gender', 'language',
  'ug_degree_id', 'ug_specialization_id', 'ug_university_id', 'ug_graduation_year',
  'pg_degree_id', 'pg_specialization_id', 'pg_university_id', 'pg_graduation_year',
  'country_id', 'state_id', 'district', 'city', 'address', 'pincode',
  'program_id', 'stage_id', 'sub_stage_id', 'remarks', 'closure_remarks',
  'assigned_to', 'team_id',
  'referred_by_lead_id', 'referral_code_used', 'referral_source',
  'first_touch_campaign_id', 'first_touch_channel', 'first_touch_source', 'first_touch_medium',
]);
const FAMILY_COLS = ['father_name', 'father_mobile', 'father_email',
  'mother_name', 'mother_mobile', 'mother_email',
  'guardian_name', 'guardian_mobile', 'guardian_email'];

const buildInsertPayload = (resolved) => {
  const lead = {};
  for (const k of Object.keys(resolved)) {
    if (LEAD_COLS.has(k)) lead[k] = resolved[k];
  }
  // Pack any family fields the row had into the nested `family` object
  // that insertLead understands (it inserts into lead_family).
  const family = {};
  for (const k of FAMILY_COLS) {
    if (resolved[k] !== undefined && resolved[k] !== '') family[k] = resolved[k];
  }
  if (Object.keys(family).length) lead.family = family;
  // Pass through sources[] if the resolver built one (channel/source/etc).
  if (resolved.sources) lead.sources = resolved.sources;
  return lead;
};

const recordDuplicate = async (tenant, import_id, row_number, raw_row, dup, resolution) => {
  const matched = matchedFieldFor(raw_row, dup);
  await tenantQuery(
    tenant,
    `INSERT INTO bulk_import_duplicates (import_id, row_number, raw_row_json, matched_lead_id, match_field, match_value, resolution, resolved_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7, CASE WHEN $7 = 'pending' THEN NULL ELSE now() END)`,
    [import_id, row_number, JSON.stringify(raw_row), dup.id, matched.field, matched.value, resolution],
  );
};

registerWorker(QUEUE_NAMES.BULK_IMPORT, async ({ name, data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;

  if (name === 'preview') {
    try {
      const { rows: [preview] } = await tenantQuery(tenant, `SELECT * FROM bulk_import_previews WHERE id = $1`, [data.preview_id]);
      if (!preview) return;
      const buf = await fetchByKey(preview.file_r2_key);
      const rows = await parseSpreadsheetBuffer(buf, preview.file_r2_key);
      const mapping = preview.field_mapping_json ?? {};
      const defaults = preview.defaults_json ?? {};
      let valid = 0; let invalid = 0; let duplicates = 0;
      const errorSamples = [];
      const dupSamples = [];
      for (const [i, row] of rows.entries()) {
        const mapped = applyMapping(row, mapping, defaults);
        const v = validateRow(mapped);
        if (!v.ok) {
          invalid += 1;
          if (errorSamples.length < 50) errorSamples.push({ row_number: i + 2, ...v.error });
          continue;
        }
        valid += 1;
        // Bulk-import dedup uses email + whatsapp_number only. Phone match
        // is intentionally skipped — institutes routinely share family
        // phone numbers across leads, which makes phone alone too noisy
        // a signal for a 30k-row upload.
        const matches = await findDuplicates(tenant, { email: v.normalized.email, whatsapp_number: v.normalized.whatsapp_number });
        if (matches.length) {
          duplicates += 1;
          if (dupSamples.length < 50) dupSamples.push({ row_number: i + 2, matches });
        }
      }
      await tenantQuery(
        tenant,
        `UPDATE bulk_import_previews
            SET total_rows = $2, valid_rows = $3, invalid_rows = $4, duplicate_rows = $5,
                sample_errors_json = $6::jsonb, duplicate_matches_json = $7::jsonb
          WHERE id = $1`,
        [data.preview_id, rows.length, valid, invalid, duplicates, JSON.stringify(errorSamples), JSON.stringify(dupSamples)],
      );
    } catch (err) {
      logger.error({ err: err.message, preview_id: data.preview_id }, 'bulk preview failed');
    }
    return;
  }

  if (name === 'commit' || name === 'retry') {
    const import_id = data.import_id ?? data.new_import_id;
    let insertedAny = false;
    try {
      await tenantQuery(tenant, `UPDATE bulk_imports SET status = 'processing', started_at = now() WHERE id = $1`, [import_id]);
      const { rows: [imp] } = await tenantQuery(tenant, `SELECT * FROM bulk_imports WHERE id = $1`, [import_id]);
      if (!imp) return;
      const buf = await fetchByKey(imp.file_r2_key);
      const rows = await parseSpreadsheetBuffer(buf, imp.file_r2_key);
      const mapping = imp.field_mapping_json ?? {};
      const defaults = imp.defaults_json ?? {};
      // Shared resolver cache: each dropdown is read once per job, and any
      // value auto-created by an early row is reused by later rows.
      const cache = createCache();
      let success = 0; let failed = 0; let duplicates = 0;
      for (const [i, row] of rows.entries()) {
        const rowNum = i + 2; // header is row 1
        const mapped = applyMapping(row, mapping, defaults);

        // (1) Validation. Invalid rows go to bulk_import_failures.
        const v = validateRow(mapped);
        if (!v.ok) {
          failed += 1;
          await tenantQuery(
            tenant,
            `INSERT INTO bulk_import_failures (import_id, row_number, raw_row_json, error_code, error_message)
             VALUES ($1,$2,$3::jsonb,$4,$5)`,
            [import_id, rowNum, JSON.stringify(row), v.error.code, v.error.message],
          );
          continue;
        }

        // (2) Resolve dropdown values to FK ids. Strict fields (stage,
        // sub_stage, country) fail the row if not found; auto-create fields
        // (program, state, universities, channel/source/...) are inserted
        // into the dropdown table on first use.
        let resolved;
        try {
          const r = await resolveDropdowns(tenant, v.normalized, cache);
          if (!r.ok) {
            failed += 1;
            await tenantQuery(
              tenant,
              `INSERT INTO bulk_import_failures (import_id, row_number, raw_row_json, error_code, error_message)
               VALUES ($1,$2,$3::jsonb,$4,$5)`,
              [import_id, rowNum, JSON.stringify(row), r.error.code, r.error.message],
            );
            continue;
          }
          resolved = r.resolved;
        } catch (err) {
          failed += 1;
          await tenantQuery(
            tenant,
            `INSERT INTO bulk_import_failures (import_id, row_number, raw_row_json, error_code, error_message)
             VALUES ($1,$2,$3::jsonb,'RESOLVER_FAILED',$4)`,
            [import_id, rowNum, JSON.stringify(row), err.message.slice(0, 500)],
          );
          continue;
        }

        // (3) Duplicate detection. Duplicates go to bulk_import_duplicates,
        // with `resolution` reflecting how the import settings handled them.
        try {
          // Same dedup policy as the preview pass: match on email +
          // whatsapp_number only, never phone. See preview block above.
          const dups = await findDuplicates(tenant, { email: resolved.email, whatsapp_number: resolved.whatsapp_number });
          if (dups.length) {
            duplicates += 1;
            const primary = dups[0];

            if (imp.duplicate_handling === 'skip') {
              await recordDuplicate(tenant, import_id, rowNum, row, primary, 'skipped');
              continue;
            }
            if (imp.duplicate_handling === 'update_existing') {
              await tenantQuery(
                tenant,
                `UPDATE leads SET
                   name = COALESCE(NULLIF($2,''), name),
                   email = COALESCE(NULLIF($3,'')::citext, email),
                   last_activity_at = now()
                 WHERE id = $1`,
                [primary.id, resolved.name ?? '', resolved.email ?? ''],
              );
              await recordDuplicate(tenant, import_id, rowNum, row, primary, 'merged');
              success += 1;
              continue;
            }
            // create_new — record the duplicate AND insert a new lead below.
            await recordDuplicate(tenant, import_id, rowNum, row, primary, 'created_anyway');
          }

          await insertLead(tenant, buildInsertPayload(resolved), imp.user_id);
          insertedAny = true;
          success += 1;
        } catch (err) {
          failed += 1;
          await tenantQuery(
            tenant,
            `INSERT INTO bulk_import_failures (import_id, row_number, raw_row_json, error_code, error_message)
             VALUES ($1,$2,$3::jsonb,'ROW_FAILED',$4)`,
            [import_id, rowNum, JSON.stringify(row), err.message.slice(0, 500)],
          );
        }
      }
      await tenantQuery(
        tenant,
        `UPDATE bulk_imports SET status = 'completed', completed_at = now(), total_rows = $2, success_rows = $3, failed_rows = $4, duplicate_rows = $5 WHERE id = $1`,
        [import_id, rows.length, success, failed, duplicates],
      );

      // (3) Auto-assign any unassigned leads — including the ones we just
      // inserted with assigned_to = null. Runs once at the end of the import
      // rather than per-row to avoid hammering the assignment rule on a 30k
      // upload. Idempotent: leads already assigned won't be touched.
      if (insertedAny) {
        try {
          const result = await autoAssignUnassigned(tenant);
          logger.info({ import_id, ...result }, 'bulk import auto-assign complete');
        } catch (err) {
          // Auto-assign failures shouldn't fail the import — the rows are
          // safely in `leads`, they just stay unassigned and the user can
          // retry from the FiltersOptions auto-assign button.
          logger.error({ err: err.message, import_id }, 'bulk import auto-assign failed');
        }
      }

      // (4) Real-time push to super_admins when the upload was done by a
      // counsellor or sales_manager — admins want to see new bulk uploads
      // happening across their tenant. We skip the notification when an
      // admin uploads their own file (no point notifying themselves).
      try {
        const { rows: [uploader] } = await tenantQuery(
          tenant,
          `SELECT name, email, role FROM users WHERE id = $1`,
          [imp.user_id],
        );
        if (uploader && uploader.role !== 'super_admin') {
          const { notifyAdmins } = await import('../lib/socket.js');
          notifyAdmins(tenant.id, 'bulk_import.completed', {
            import_id,
            uploader_id: imp.user_id,
            uploader_name: uploader.name,
            uploader_email: uploader.email,
            uploader_role: uploader.role,
            total_rows: rows.length,
            success_rows: success,
            failed_rows: failed,
            duplicate_rows: duplicates,
          });
        }
      } catch (err) {
        logger.warn({ err: err.message, import_id }, 'bulk import admin notify failed');
      }
    } catch (err) {
      logger.error({ err: err.message, import_id }, 'bulk import failed');
      await tenantQuery(tenant, `UPDATE bulk_imports SET status = 'failed', completed_at = now() WHERE id = $1`, [import_id]);
    }
    return;
  }

  if (name === 'retry_row' && data.failure_id) {
    const { rows: [fail] } = await tenantQuery(tenant, `SELECT * FROM bulk_import_failures WHERE id = $1`, [data.failure_id]);
    if (!fail) return;
    try {
      await insertLead(tenant, fail.raw_row_json, null);
      await tenantQuery(tenant, `UPDATE bulk_import_failures SET retried_at = now() WHERE id = $1`, [data.failure_id]);
    } catch (err) {
      logger.error({ err: err.message, failure_id: data.failure_id }, 'retry_row failed');
    }
  }
}, { concurrency: 2, jobName: '*' });
