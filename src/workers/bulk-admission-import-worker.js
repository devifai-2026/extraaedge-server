// Accounts-side importer for historical admissions migrated off a previous
// CRM. One spreadsheet row fans out into up to five tables:
//
//   leads                   the student (at the tenant's Enrolled stage)
//   lead_fee_offers         the agreed price breakup (when it fits — see below)
//   admissions              the admission record itself, + education rows
//   admission_fee_schedule  the full EMI plan, paid and unpaid alike
//   admission_receipts      one row per amount ALREADY collected, flagged
//                           is_old_collection so pre-system money stays
//                           distinguishable from money taken in-app
//
// Those last two are exactly what admissions/repo.paySchedule reads, so an
// imported student lands correctly on Pay Schedule / Payment Details /
// Collection Receipt-wise with no report changes.
//
// Runs on its own queue rather than a second job name on BULK_IMPORT: in
// in-process mode registerWorker binds jobName '*', so sharing a queue would
// hand every lead-import job to this worker as well.
import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { getDownloadSignedUrl } from '../lib/r2.js';
import { parseXlsxWithImages } from '../lib/csv.js';
import { findDuplicates, insertLead } from '../modules/leads/repo.js';
import * as admissionsRepo from '../modules/admissions/repo.js';
import * as feeOffersRepo from '../modules/lead-fee-offers/repo.js';
import * as tenantsRepo from '../modules/tenants/repo.js';
import * as events from '../modules/admissions/events-repo.js';
import { createCache, resolveDropdowns, resolveEnrolledStage } from '../modules/bulk-admissions/resolver.js';
import { createOwnerCache, resolveOwner } from '../modules/bulk-admissions/owner-resolver.js';
// The per-row rules live in the module, not here, so they can be tested
// without a tenant / queue / spreadsheet. This file is the orchestration.
import { parseRow, utrsOf, attachmentsOf } from '../modules/bulk-admissions/row-parser.js';
import { OFFER_MAX_INSTALLMENTS, ATTACHMENT_COLUMNS } from '../modules/bulk-admissions/columns.js';
import { fetchRemoteImage, looksLikeUrl, RemoteImageError } from '../lib/remote-image.js';
import { notifyUser } from '../lib/socket.js';
import { logger } from '../lib/logger.js';

const fail = (code, message) => ({ ok: false, error: { code, message } });

// Ceiling for the uploaded workbook. Well above the lead importer's 25 MB
// because images pasted into cells live inside the .xlsx — and image bytes
// are already compressed, so unlike the XML bloat that cap guards against,
// the size here tracks real content. Matches UPLOAD_SIZE_LIMITS.admission_import.
const MAX_IMPORT_BYTES = 150 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Progress + download plumbing (mirrors bulk-import-worker.js)
// ---------------------------------------------------------------------------
const PROGRESS_THROTTLE_MS = 250;
const PROGRESS_FORCE_EVERY = 25; // lower than the lead importer's 100: each
// row here does five table writes, so rows arrive slower and a 100-row stride
// would leave the dialog looking frozen on a 55-row file.

const makeProgressEmitter = (tenant, imp) => {
  if (!imp?.user_id) return () => {};
  let lastEmitAt = 0;
  let lastEmitRow = 0;
  return (state, { force = false } = {}) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_THROTTLE_MS && state.processed - lastEmitRow < PROGRESS_FORCE_EVERY) return;
    lastEmitAt = now;
    lastEmitRow = state.processed;
    try {
      notifyUser(tenant.id, imp.user_id, 'bulk_import.progress', {
        import_id: imp.id,
        kind: 'admissions',
        total: state.total,
        processed: state.processed,
        success: state.success,
        failed: state.failed,
        duplicates: state.duplicates,
        phase: state.phase,
      });
    } catch { /* socket errors must never break an import */ }
  };
};

const fetchByKey = async (key) => {
  const url = await getDownloadSignedUrl({ key, expiresIn: 60 });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download upload: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

// ---------------------------------------------------------------------------
// DB-side checks that can fail a row before we write anything.
// ---------------------------------------------------------------------------

// A UTR names one real bank transaction, so it can never appear twice.
// `seen` catches repeats WITHIN the file (the realistic mistake: one cell
// dragged down a column) — the DB's partial unique index would only catch
// that on the second row, after the first receipt had already been written.
const checkUtrs = async (tenant, row, seen) => {
  for (const { column, value } of utrsOf(row)) {
    const key = value.toUpperCase();
    const prevRow = seen.get(key);
    if (prevRow !== undefined) {
      return fail('DUPLICATE_UTR', `${column} "${value}" is already used on row ${prevRow} of this file — a UTR identifies one transaction and can't repeat`);
    }
    const { rows } = await tenantQuery(
      tenant,
      `SELECT 1 FROM admission_receipts
        WHERE upper(utr) = $1 AND deleted_at IS NULL LIMIT 1`,
      [key],
    );
    if (rows[0]) {
      return fail('UTR_ALREADY_USED', `${column} "${value}" is already recorded against a receipt in this system`);
    }
  }
  return { ok: true };
};

// Preview-time image check. For a URL, downloads it to confirm it's reachable,
// public and actually an image — then throws the bytes away. For a typed file
// name, confirms something with that name was attached.
//
// Downloading twice is deliberate: a link is only truly verified by fetching
// it (HEAD often lies, and Drive serves an HTML interstitial with a 200), and
// the alternative is discovering a dead link halfway through a commit that has
// already created students. Returns a fail() shape or null.
const checkImages = async (row, attachmentNames) => {
  for (const { column, value, code } of attachmentsOf(row)) {
    if (looksLikeUrl(value)) {
      try {
        await fetchRemoteImage(value);
      } catch (err) {
        if (err instanceof RemoteImageError) return fail(code, `${column}: ${err.message} (${value})`);
        throw err;
      }
      continue;
    }
    // A typed file name. We can't tell here whether the cell ALSO has an
    // image pasted over it (that's resolved at commit, where the workbook's
    // image anchors are read) — so only flag a name that matches nothing,
    // which is unambiguously wrong either way.
    if (!attachmentNames.has(String(value).trim().toLowerCase())) {
      return fail(code, `${column} "${value}" doesn't match any attached file — attach it on the upload screen, paste the image into the cell, or use an https link`);
    }
  }
  return null;
};

// Store one image buffer and return its key. Shared by the embedded-image and
// URL paths so both land in the same place with the same naming.
const storeImage = async (tenant, { buffer, extension, contentType }, importId) => {
  const { putObject, buildKey } = await import('../lib/r2.js');
  const { nanoid } = await import('nanoid');
  const key = buildKey({
    tenantSlug: tenant.slug, purpose: 'admission_photo', id: nanoid(24), ext: extension,
  });
  await putObject({
    key,
    body: buffer,
    contentType: contentType || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
    metadata: { source: 'admission_import', import_id: String(importId) },
  });
  return key;
};

// Work out the storage key for each image this row needs.
//
// Three accepted forms per cell, checked in this order:
//   1. an image pasted into the cell — matched on (sheet row, column), so
//      nothing has to be named and nothing can drift
//   2. an https link — fetched server-side and copied into our own storage,
//      so the record survives the source link later being deleted or made
//      private. See lib/remote-image.js for the SSRF guards on that fetch.
//   3. a file name matched against files attached on the upload screen —
//      the workable path for hundreds of images, where embedding them all
//      would make the workbook itself unopenable
//
// A cell with a value we can't resolve fails the row. A blank cell with no
// embedded image just means "no image for this one".
const resolveAttachments = async (tenant, row, sheetRow, attachments, embedded, importId, urlCache) => {
  const resolved = {};

  // Embedded images can satisfy a column whose cell is empty, so walk the
  // embedded set directly rather than only the columns attachmentsOf() found.
  for (const [column, key] of embedded.get(sheetRow) ?? []) {
    resolved[column] = key;
  }

  for (const { column, value, code } of attachmentsOf(row)) {
    if (resolved[column]) continue; // an embedded image on this cell wins

    if (looksLikeUrl(value)) {
      // Cached by URL: the same hosted photo often appears on several rows
      // (a shared placeholder, or a re-run of a corrected file), and there's
      // no reason to re-download and re-store it each time.
      const cacheKey = value.trim();
      if (urlCache.has(cacheKey)) { resolved[column] = urlCache.get(cacheKey); continue; }
      try {
        const image = await fetchRemoteImage(value);
        const key = await storeImage(tenant, image, importId);
        urlCache.set(cacheKey, key);
        resolved[column] = key;
      } catch (err) {
        if (err instanceof RemoteImageError) {
          return fail(code, `${column}: ${err.message} (${value})`);
        }
        throw err;
      }
      continue;
    }

    const key = attachments.get(value.trim().toLowerCase());
    if (!key) {
      return fail(code, `${column} "${value}" couldn't be resolved — paste the image into that cell, give an https link to it, or attach a file with this exact name on the upload screen`);
    }
    resolved[column] = key;
  }
  return { ok: true, resolved };
};

// Pull every image embedded in the sheet into storage once, up front, and
// index them as sheetRow -> [[column, r2_key]].
//
// Done as a batch before the row loop because the same workbook parse yields
// them all, and a row that fails validation shouldn't leave a half-uploaded
// image behind mid-loop. Only columns that actually take an image are kept —
// a logo pasted in the corner of the sheet is silently ignored rather than
// attached to a student.
const stageEmbeddedImages = async (tenant, images, importId) => {
  const byRow = new Map();
  if (!images.length) return byRow;
  let staged = 0;
  for (const img of images) {
    if (!ATTACHMENT_COLUMNS.includes(img.column)) continue;
    const key = await storeImage(tenant, img, importId);
    if (!byRow.has(img.sheetRow)) byRow.set(img.sheetRow, []);
    byRow.get(img.sheetRow).push([img.column, key]);
    staged += 1;
  }
  logger.info({ import_id: importId, staged, found: images.length }, 'admission import: staged embedded images');
  return byRow;
};

// ---------------------------------------------------------------------------
// Row write.
// ---------------------------------------------------------------------------
const writeRow = async (tenant, ctx, row, resolved, owner, attachmentKeys) => {
  const { actorId, enrolled, receiptConfig, importId } = ctx;

  // Exactly what THIS call inserts, so a mid-row failure can be undone
  // without touching anything that was already here. Populated as we go.
  const created = { leadId: null, feeOfferForLeadId: null, admissionId: null };

  // ---- 1. Lead ----
  let leadId = resolved.existing_lead_id ?? null;
  if (!leadId) {
    const lead = await insertLead(tenant, {
      name: row.name,
      first_name: row.first_name,
      last_name: [row.middle_name, row.last_name].filter(Boolean).join(' ') || null,
      email: row.email,
      whatsapp_number: row.whatsapp_number,
      phone: row.whatsapp_number,
      alternate_contact: row.alternate_contact,
      gender: row.gender,
      address: row.address,
      city: row.city,
      pincode: row.pincode,
      country_id: resolved.country_id,
      state_id: resolved.state_id,
      branch_id: resolved.branch_id,
      program_id: resolved.program_id,
      stage_id: enrolled.stage_id,
      sub_stage_id: enrolled.sub_stage_id,
      assigned_to: owner?.id ?? null,
      manager_id: owner?.manager_id ?? null,
      // Backdate the lead to the real admission date. insertLead honours
      // caller-supplied created_at/converted_at, and its own converted_at
      // stamp only fires when the field is still empty — so passing it here
      // wins over now() and the historical timeline stays truthful.
      created_at: row.admission_date,
      updated_at: row.admission_date,
      converted_at: row.admission_date,
    }, actorId);
    leadId = lead.id;
    created.leadId = lead.id;
  }

  try {
    // ---- 2. Fee offer ----
    // Two reasons this is conditional, both about not clobbering better data:
    //
    //  • Over OFFER_MAX_INSTALLMENTS we skip entirely.
    //    lead_fee_offers.fee_installments is capped at 4 by its zod schema and
    //    the Configure Fee Offer modal renders exactly 4 slots, so a 5th would
    //    be invisible there and silently dropped on the next save. The
    //    admission, schedule and receipts below carry the full plan regardless
    //    — they're what drives every report.
    //
    //  • If the lead ALREADY has an offer, leave it alone. That row was
    //    configured by hand by the accounts team (the normal pre-admission
    //    flow), which makes it more authoritative than a spreadsheet
    //    reconstruction of the same numbers.
    // null when written; otherwise WHY it wasn't, so the audit trail can
    // distinguish "we deferred to a hand-configured offer" from "the plan
    // didn't fit".
    let feeOfferSkipped = null;
    const existingOffer = await feeOffersRepo.findByLead(tenant, leadId);
    if (existingOffer) {
      feeOfferSkipped = 'lead already has a hand-configured fee offer';
    } else if (row.installments.length <= OFFER_MAX_INSTALLMENTS) {
      created.feeOfferForLeadId = leadId;
      await feeOffersRepo.upsert(tenant, leadId, {
        program_id: resolved.program_id,
        course_fees: row.course_fees,
        registration_amount: row.registration.amount,
        registration_date: row.registration.paid_amount > 0 ? row.registration.paid_date : null,
        mode_of_training: row.mode_of_training,
        payment_mode: row.mode_of_payment.toLowerCase(), // 'Installment' -> 'installment'
        fee_installments: row.installments.length
          ? row.installments.map((i) => ({
            installment_no: i.installment_no, amount: i.amount, due_date: i.due_date,
          }))
          : null,
        payment_account_id: resolved.payment_account_id ?? null,
      }, actorId);
    } else {
      feeOfferSkipped = `plan has more than ${OFFER_MAX_INSTALLMENTS} installments`;
    }

    // ---- 3. Admission (+ education + full EMI schedule) ----
    const admission = await admissionsRepo.insert(tenant, {
      lead_id: leadId,
      admission_date: row.admission_date,
      first_name: row.first_name,
      middle_name: row.middle_name,
      last_name: row.last_name,
      email: row.email,
      // admissions.whatsapp_number is NOT NULL at the schema layer; a row can
      // legitimately reach here with only an email, so fall back to ''.
      whatsapp_number: row.whatsapp_number ?? '',
      alternate_contact: row.alternate_contact,
      address: row.address,
      program_id: resolved.program_id,
      mode_of_training: row.mode_of_training,
      center_id: resolved.center_id ?? null,
      total_fees: row.course_fees,
      mode_of_payment: row.mode_of_payment,
      status: row.status,
      photo_r2_key: attachmentKeys.photo ?? null,
      guided_by_counsellor_id: owner?.id ?? null,
      guided_by_manager_id: owner?.manager_id ?? null,
      source: row.source,
      education: row.education,
      // Every installment, paid or not. The schedule is the PLAN; what was
      // collected against it lives in receipts. Writing only the unpaid ones
      // would make the plan un-reconstructable and break the Pay Schedule
      // report's next-due calculation for part-paid students.
      fee_schedule: row.installments.map((i) => ({
        installment_no: i.installment_no, due_date: i.due_date, amount: i.amount,
      })),
    }, actorId);

    created.admissionId = admission.id;

    // Columns admissionsRepo.insert doesn't take, set in one follow-up UPDATE:
    //
    //   break_reason — not in the repo's INSERT column list.
    //   approved_by/at — anything other than pending_approval is, by
    //     definition, already-approved history. Without this the row sits as
    //     an unapproved 'attending' admission, a state the normal flow can't
    //     produce and one the Approvals queue would surface forever.
    //   dropped_* — the drop audit trio, so a dropped import matches what
    //     admissions/service.drop would have written.
    const sets = [];
    const params = [admission.id];
    const push = (sql, value) => { params.push(value); sets.push(sql.replace('$?', `$${params.length}`)); };

    if (row.break_reason) push('break_reason = $?', row.break_reason);
    if (row.status !== 'pending_approval') {
      push('approved_by = $?', actorId ?? null);
      sets.push('approved_at = now()');
    }
    if (row.status === 'dropped') {
      push('dropped_by = $?', actorId ?? null);
      push('dropped_reason = $?', row.break_reason);
      sets.push('dropped_at = now()');
    }
    if (sets.length) {
      await tenantQuery(tenant, `UPDATE admissions SET ${sets.join(', ')} WHERE id = $1`, params);
    }

    // ---- 4. Receipts for money already collected ----
    const receipts = [];
    if (row.registration.paid_amount > 0) {
      receipts.push({
        receipt_date: row.registration.paid_date,
        amount: row.registration.paid_amount,
        mode_of_payment: row.collection_mode,
        receipt_kind: 'registration',
        utr: row.registration.utr,
        payment_screenshot_r2_key: attachmentKeys.registration_proof ?? null,
        transaction_details: 'Imported from previous system',
      });
    }
    for (const inst of row.installments) {
      if (inst.paid_amount <= 0) continue;
      receipts.push({
        receipt_date: inst.paid_date,
        amount: inst.paid_amount,
        mode_of_payment: row.collection_mode,
        receipt_kind: 'installment',
        installment_no: inst.installment_no,
        utr: inst.utr,
        payment_screenshot_r2_key: attachmentKeys[`emi_${inst.installment_no}_proof`] ?? null,
        transaction_details: 'Imported from previous system',
      });
    }
    for (const r of receipts) {
      await admissionsRepo.insertReceipt(
        tenant, admission.id,
        { ...r, is_old_collection: true, payment_account_id: resolved.payment_account_id ?? null },
        actorId, receiptConfig,
      );
    }

    // ---- 5. Timeline ----
    events.log(tenant, {
      admission_id: admission.id,
      lead_id: leadId,
      event_type: events.EVENT_TYPES.CREATED,
      next_status: row.status,
      actor_user_id: actorId,
      // system, not user: nobody sat and typed this record, and the timeline
      // reading "imported" rather than "created by <accounts user>" is what
      // makes a later audit legible.
      actor_kind: events.ACTOR_KINDS.SYSTEM,
      summary: `Imported from previous system · ${receipts.length} past payment${receipts.length === 1 ? '' : 's'}`,
      metadata: {
        bulk_import_id: importId,
        attached_to_existing_lead: Boolean(resolved.existing_lead_id),
        receipts: receipts.length,
        installments: row.installments.length,
        fee_offer_skipped_reason: feeOfferSkipped,
      },
    });

    return { admission_id: admission.id, lead_id: leadId, receipts: receipts.length, feeOfferSkipped };
  } catch (err) {
    // Each repo call opens its own transaction, so a mid-row failure would
    // otherwise leave a half-built student behind. Compensate explicitly,
    // undoing ONLY what this row created — see rollbackRow.
    await rollbackRow(tenant, created).catch((rollbackErr) => {
      logger.error(
        { err: rollbackErr.message, ...created },
        'admission import: rollback failed, partial row may remain',
      );
    });
    throw err;
  }
};

// Undo a partially-written row.
//
// Scoped deliberately narrowly. Earlier this deleted by lead_id, which is
// wrong twice over: a lead can carry an admission we didn't create (a
// re-import onto an existing student), and an existing lead often already
// has a fee offer the accounts team configured by hand — the normal
// pre-admission flow. Blowing either away to clean up our own failure would
// destroy records that were never ours.
//
// So we only remove rows this call actually inserted. Deleting the admission
// cascades to its education, fee schedule and receipts.
const rollbackRow = async (tenant, created) => {
  if (created.admissionId) {
    await tenantQuery(tenant, `DELETE FROM admissions WHERE id = $1`, [created.admissionId]);
  }
  if (created.feeOfferForLeadId) {
    await tenantQuery(tenant, `DELETE FROM lead_fee_offers WHERE lead_id = $1`, [created.feeOfferForLeadId]);
  }
  if (created.leadId) {
    await tenantQuery(tenant, `DELETE FROM leads WHERE id = $1`, [created.leadId]);
  }
  logger.warn({ ...created }, 'admission import: rolled back a partially-written row');
};

// ---------------------------------------------------------------------------
// Batched writers for the failure / duplicate side tables.
// ---------------------------------------------------------------------------
const FLUSH_SIZE = 200;

const createBatchWriter = (tenant) => {
  const failures = [];
  const duplicates = [];

  const flushFailures = async () => {
    if (!failures.length) return;
    const batch = failures.splice(0, failures.length);
    const values = [];
    const params = [];
    batch.forEach((f, idx) => {
      const b = idx * 5;
      values.push(`($${b + 1},$${b + 2},$${b + 3}::jsonb,$${b + 4},$${b + 5})`);
      params.push(f.import_id, f.row_number, JSON.stringify(f.raw_row), f.error_code, f.error_message);
    });
    await tenantQuery(
      tenant,
      `INSERT INTO bulk_import_failures (import_id, row_number, raw_row_json, error_code, error_message)
       VALUES ${values.join(',')}`,
      params,
    );
  };

  const flushDuplicates = async () => {
    if (!duplicates.length) return;
    const batch = duplicates.splice(0, duplicates.length);
    const values = [];
    const params = [];
    batch.forEach((d, idx) => {
      const b = idx * 7;
      values.push(`($${b + 1},$${b + 2},$${b + 3}::jsonb,$${b + 4},$${b + 5},$${b + 6},$${b + 7}, now())`);
      params.push(d.import_id, d.row_number, JSON.stringify(d.raw_row), d.matched_lead_id, d.match_field, d.match_value, d.resolution);
    });
    await tenantQuery(
      tenant,
      `INSERT INTO bulk_import_duplicates (import_id, row_number, raw_row_json, matched_lead_id, match_field, match_value, resolution, resolved_at)
       VALUES ${values.join(',')}`,
      params,
    );
  };

  return {
    addFailure(import_id, row_number, raw_row, error_code, error_message) {
      failures.push({ import_id, row_number, raw_row, error_code, error_message });
      return failures.length >= FLUSH_SIZE ? flushFailures() : undefined;
    },
    addDuplicate(import_id, row_number, raw_row, dup, resolution, matchField, matchValue) {
      duplicates.push({
        import_id, row_number, raw_row,
        matched_lead_id: dup.id, match_field: matchField, match_value: matchValue, resolution,
      });
      return duplicates.length >= FLUSH_SIZE ? flushDuplicates() : undefined;
    },
    flush: async () => { await flushFailures(); await flushDuplicates(); },
  };
};

// Which field triggered the duplicate match, for the duplicates table.
// match_field has a CHECK constraint, so it must be one of these three.
const matchedFieldFor = (row, dup) => {
  if (row.email && dup.email && row.email === String(dup.email).toLowerCase()) {
    return { field: 'email', value: row.email };
  }
  if (row.whatsapp_number && dup.whatsapp_number && row.whatsapp_number === dup.whatsapp_number) {
    return { field: 'whatsapp_number', value: row.whatsapp_number };
  }
  return { field: 'phone', value: row.whatsapp_number || row.email || '' };
};

// Duplicate detection mirrors the lead importer: email + whatsapp, with phone
// as a fallback only when the row has neither (institutes routinely share a
// family phone across students, so phone alone is too noisy a signal).
const findLeadMatch = async (tenant, row) => {
  const matches = await findDuplicates(
    tenant,
    { email: row.email, whatsapp_number: row.whatsapp_number, phone: row.whatsapp_number },
    { matchPhone: !(row.email || row.whatsapp_number) },
  );
  return matches[0] ?? null;
};

// ---------------------------------------------------------------------------
registerWorker(QUEUE_NAMES.BULK_ADMISSION_IMPORT, async ({ name, data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;

  // ---------------- PREVIEW ----------------
  // Validation-only dry run: parse every row and count what would happen, so
  // the operator sees the damage before committing. Nothing is written.
  if (name === 'preview') {
    try {
      const { rows: [preview] } = await tenantQuery(tenant, `SELECT * FROM bulk_import_previews WHERE id = $1`, [data.preview_id]);
      if (!preview) return;
      const { rows: sheet } = await parseXlsxWithImages(await fetchByKey(preview.file_r2_key), { maxBytes: MAX_IMPORT_BYTES });

      let valid = 0; let invalid = 0; let duplicates = 0;
      const errorSamples = [];
      const dupSamples = [];
      const utrSeen = new Map();
      // Names of the files attached on the upload screen, so a typo'd file
      // name is caught HERE rather than after the operator has committed.
      const attachmentNames = new Set(
        Object.keys(preview.defaults_json?.attachments ?? {}).map((n) => n.trim().toLowerCase()),
      );

      for (const [i, raw] of sheet.entries()) {
        // The real sheet row, not the array index — blank rows in the middle
        // of a file compact the array, and an operator needs the line number
        // they can actually go and look at.
        const rowNumber = raw.__sheetRow ?? i + 2;
        const parsed = parseRow(raw);
        if (!parsed.ok) {
          invalid += 1;
          if (errorSamples.length < 50) errorSamples.push({ row_number: rowNumber, ...parsed.error });
          continue;
        }
        const utrCheck = await checkUtrs(tenant, parsed.row, utrSeen);
        if (!utrCheck.ok) {
          invalid += 1;
          if (errorSamples.length < 50) errorSamples.push({ row_number: rowNumber, ...utrCheck.error });
          continue;
        }
        for (const { value } of utrsOf(parsed.row)) utrSeen.set(value.toUpperCase(), rowNumber);

        // Check image links now, while nothing has been written. A dead or
        // private link is by far the most likely thing to be wrong about a
        // URL, and finding out mid-import — after 30 students already
        // landed — is the worst time to hear it. Shape only: HEAD-equivalent
        // reachability, no download, no storage.
        const badLink = await checkImages(parsed.row, attachmentNames);
        if (badLink) {
          invalid += 1;
          if (errorSamples.length < 50) errorSamples.push({ row_number: rowNumber, ...badLink.error });
          continue;
        }

        valid += 1;
        const match = await findLeadMatch(tenant, parsed.row);
        if (match) {
          duplicates += 1;
          if (dupSamples.length < 50) dupSamples.push({ row_number: rowNumber, matches: [match] });
        }
      }

      await tenantQuery(
        tenant,
        `UPDATE bulk_import_previews
            SET total_rows = $2, valid_rows = $3, invalid_rows = $4, duplicate_rows = $5,
                sample_errors_json = $6::jsonb, duplicate_matches_json = $7::jsonb
          WHERE id = $1`,
        [data.preview_id, sheet.length, valid, invalid, duplicates, JSON.stringify(errorSamples), JSON.stringify(dupSamples)],
      );
    } catch (err) {
      logger.error({ err: err.message, code: err.code, preview_id: data.preview_id }, 'admission import preview failed');
      // Record the failure ON the preview row. The dialog polls until counts
      // appear, so a silent throw would leave it spinning until timeout.
      const message = err.code === 'XLSX_TOO_LARGE'
        ? err.message
        : 'Could not read this spreadsheet. Re-save it as a fresh .xlsx and try again.';
      await tenantQuery(
        tenant,
        `UPDATE bulk_import_previews
            SET total_rows = 0, valid_rows = 0, invalid_rows = 1, duplicate_rows = 0,
                sample_errors_json = $2::jsonb
          WHERE id = $1`,
        [data.preview_id, JSON.stringify([{ row_number: 0, code: err.code ?? 'PARSE_ERROR', message }])],
      ).catch((updateErr) => {
        logger.error({ err: updateErr.message, preview_id: data.preview_id }, 'failed to record admission preview error');
      });
    }
    return;
  }

  // ---------------- COMMIT ----------------
  if (name !== 'commit') return;

  const { rows: [imp] } = await tenantQuery(tenant, `SELECT * FROM bulk_imports WHERE id = $1`, [data.import_id]);
  if (!imp || imp.status !== 'queued') return; // already picked up, or gone

  await tenantQuery(tenant, `UPDATE bulk_imports SET status = 'processing', started_at = now() WHERE id = $1`, [imp.id]);

  const emitProgress = makeProgressEmitter(tenant, imp);
  const batch = createBatchWriter(tenant);
  const state = { total: 0, processed: 0, success: 0, failed: 0, duplicates: 0, phase: 'importing' };

  try {
    const { rows: sheet, images } = await parseXlsxWithImages(await fetchByKey(imp.file_r2_key), { maxBytes: MAX_IMPORT_BYTES });
    state.total = sheet.length;
    emitProgress(state, { force: true });

    const cache = createCache();
    const ownerCache = createOwnerCache();
    const utrSeen = new Map();

    const enrolled = await resolveEnrolledStage(tenant, cache);
    if (!enrolled) {
      // Every row would fail identically, so fail the whole job with one
      // actionable message rather than writing N copies of it.
      throw new Error('No "converted" stage is configured for this institute — mark one stage as a success stage under Settings → Dropdowns → Stages, then re-upload.');
    }

    // Attachment map, lower-cased for case-insensitive file-name matching.
    const attachments = new Map(
      Object.entries(imp.defaults_json?.attachments ?? {})
        .map(([fileName, key]) => [String(fileName).trim().toLowerCase(), key]),
    );
    // Images pasted into the sheet, copied into storage up front and indexed
    // by (sheet row -> [column, key]).
    const embedded = await stageEmbeddedImages(tenant, images, imp.id);
    // Downloaded-URL keys, so a link repeated across rows is fetched once.
    const urlCache = new Map();

    const ctx = {
      actorId: imp.user_id,
      enrolled,
      importId: imp.id,
      // Receipt numbering config lives on the SYSTEM tenants row, so it can't
      // come off req.tenant. Read once per job rather than per receipt.
      receiptConfig: await tenantsRepo.findById(tenant.id)
        .then((t) => (t ? { prefix: t.receipt_no_prefix, start: t.receipt_no_start, pad: t.receipt_no_pad } : null))
        .catch(() => null),
    };

    let feeOffersSkipped = 0;

    for (const [i, raw] of sheet.entries()) {
      const rowNumber = raw.__sheetRow ?? i + 2;
      state.processed += 1;

      try {
        const parsed = parseRow(raw);
        if (!parsed.ok) {
          state.failed += 1;
          await batch.addFailure(imp.id, rowNumber, raw, parsed.error.code, parsed.error.message);
          continue;
        }
        const row = parsed.row;

        const dropdowns = await resolveDropdowns(tenant, {
          country: row.country, state: row.state, course: row.course,
          center: row.center, branch: row.branch, payment_account: row.payment_account,
        }, cache);
        if (!dropdowns.ok) {
          state.failed += 1;
          await batch.addFailure(imp.id, rowNumber, raw, dropdowns.error.code, dropdowns.error.message);
          continue;
        }
        const resolved = dropdowns.resolved;

        const ownerRes = await resolveOwner(tenant, ownerCache, row.lead_owner_email);
        if (!ownerRes.ok) {
          state.failed += 1;
          await batch.addFailure(imp.id, rowNumber, raw, ownerRes.error.code, ownerRes.error.message);
          continue;
        }

        const utrCheck = await checkUtrs(tenant, row, utrSeen);
        if (!utrCheck.ok) {
          state.failed += 1;
          await batch.addFailure(imp.id, rowNumber, raw, utrCheck.error.code, utrCheck.error.message);
          continue;
        }

        const attach = await resolveAttachments(tenant, row, rowNumber, attachments, embedded, imp.id, urlCache);
        if (!attach.ok) {
          state.failed += 1;
          await batch.addFailure(imp.id, rowNumber, raw, attach.error.code, attach.error.message);
          continue;
        }

        // ---- Duplicate handling ----
        const match = await findLeadMatch(tenant, row);
        if (match) {
          state.duplicates += 1;
          const { field, value } = matchedFieldFor(row, match);
          if (imp.duplicate_handling === 'skip') {
            await batch.addDuplicate(imp.id, rowNumber, raw, match, 'skipped', field, value);
            await batch.addFailure(imp.id, rowNumber, raw, 'DUPLICATE_SKIPPED', `Matched existing lead "${match.name || value}" on ${field}, and duplicate handling is set to Skip`);
            state.failed += 1;
            continue;
          }
          // use_existing: attach the admission to the lead already on file.
          const { rows: existingAdm } = await tenantQuery(
            tenant,
            `SELECT id, admission_code FROM admissions WHERE lead_id = $1 AND deleted_at IS NULL LIMIT 1`,
            [match.id],
          );
          if (existingAdm[0]) {
            // Not a merge candidate: re-importing would double-count this
            // student's money. Bounce it so a re-run of a corrected file is
            // safe to do as many times as needed.
            state.failed += 1;
            await batch.addDuplicate(imp.id, rowNumber, raw, match, 'skipped', field, value);
            await batch.addFailure(
              imp.id, rowNumber, raw, 'ADMISSION_EXISTS',
              `"${match.name || value}" already has admission ${existingAdm[0].admission_code || existingAdm[0].id} in this system — importing again would double-count their payments`,
            );
            continue;
          }
          resolved.existing_lead_id = match.id;
          await batch.addDuplicate(imp.id, rowNumber, raw, match, 'merged', field, value);
        }

        const written = await writeRow(tenant, ctx, row, resolved, ownerRes.user, attach.resolved);
        if (written.feeOfferSkipped) feeOffersSkipped += 1;
        for (const { value } of utrsOf(row)) utrSeen.set(value.toUpperCase(), rowNumber);
        state.success += 1;
      } catch (err) {
        state.failed += 1;
        logger.error({ err: err.message, row: rowNumber, import_id: imp.id }, 'admission import row failed');
        await batch.addFailure(imp.id, rowNumber, raw, 'ROW_FAILED', err.message);
      }

      emitProgress(state);
    }

    await batch.flush();
    state.phase = 'completed';
    await tenantQuery(
      tenant,
      `UPDATE bulk_imports
          SET status = 'completed', completed_at = now(),
              total_rows = $2, success_rows = $3, failed_rows = $4, duplicate_rows = $5
        WHERE id = $1`,
      [imp.id, state.total, state.success, state.failed, state.duplicates],
    );
    emitProgress(state, { force: true });
    if (feeOffersSkipped) {
      logger.info(
        { import_id: imp.id, rows: feeOffersSkipped, cap: OFFER_MAX_INSTALLMENTS },
        'admission import: fee offer skipped for rows over the installment cap',
      );
    }
  } catch (err) {
    logger.error({ err: err.message, import_id: imp.id }, 'admission import failed');
    await batch.flush().catch(() => {});
    // Surface the reason on the import row itself — the operator sees this,
    // not the logs. Reuses bulk_import_failures with row_number 0 for the
    // whole-job case so there's one place to look.
    await batch.addFailure(imp.id, 0, {}, 'IMPORT_FAILED', err.message);
    await batch.flush().catch(() => {});
    await tenantQuery(
      tenant,
      `UPDATE bulk_imports SET status = 'failed', completed_at = now(),
              success_rows = $2, failed_rows = $3, duplicate_rows = $4
        WHERE id = $1`,
      [imp.id, state.success, state.failed, state.duplicates],
    ).catch(() => {});
    state.phase = 'completed';
    emitProgress(state, { force: true });
  }
});

logger.info('bulk-admission-import worker registered');
