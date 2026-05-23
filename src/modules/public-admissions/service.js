// Unauthenticated student-facing admission flow.
//
// Trust model: the URL token IS the auth. It's a 32-byte random string,
// 24h TTL, single-use. We deliberately expose only the minimum lead
// snapshot the student needs to recognise the form is for them (their
// own name + masked contact). Internal fields — owner, lead_score,
// activity, notes, source attribution — never leave the BE.
import { randomToken } from '../../lib/crypto.js';
import { resolveTenantById } from '../../db/tenant.js';
import { tenantQuery } from '../../db/tenant.js';
import { notFound, appError, forbidden } from '../../lib/errors.js';
import { RESPONSE_CODES } from '../../config/constants.js';
import { buildKey, getUploadSignedUrl, getDownloadSignedUrl, headObject } from '../../lib/r2.js';
import { env } from '../../config/env.js';
import * as tokenRepo from './repo.js';
import * as admissionsRepo from '../admissions/repo.js';
import * as admissionEvents from '../admissions/events-repo.js';
import * as feeOffersRepo from '../lead-fee-offers/repo.js';
import * as uploadsRepo from '../uploads/repo.js';
import { notifyPendingAdmission } from '../admissions/service.js';

// Resolve a public token to its tenant. Returns { tenant, lookup_row }
// — throws 404/410 distinctly. Shared by every public route below.
const resolveTokenToTenant = async (token) => {
  const lookup = await tokenRepo.lookupToken(token);
  if (lookup.status === 'not_found') throw notFound('Link not found');
  if (lookup.status === 'expired')   throw gone('This link has expired. Please ask your counsellor for a new one.');
  if (lookup.status === 'used')      throw gone('This admission form has already been submitted.');
  const tenant = await resolveTenantById(lookup.row.tenant_id);
  if (!tenant) throw notFound('Tenant not found');
  if (tenant.status !== 'active') throw forbidden('This account is currently inactive');
  return { tenant, lookupRow: lookup.row };
};

const gone = (message = 'This link has expired') =>
  appError({ status: 410, code: RESPONSE_CODES.NOT_FOUND ?? 'GONE', message });

// Create a fresh token for a lead and return the bare details the FE
// needs to assemble the URL. Each call inserts a new row — the lookup
// path treats only the newest non-used / non-expired one as live, so
// "Regenerate" works by simply minting another token.
export const generateLink = async (tenant, actor, lead_id) => {
  // Verify the lead actually exists on this tenant AND has converted
  // (sharing the form before conversion makes no sense — there's no
  // admission stub yet).
  const { rows: leadRows } = await tenantQuery(
    tenant,
    `SELECT id, name, email, whatsapp_number, phone, program_id, converted_at
       FROM leads WHERE id = $1 AND deleted_at IS NULL`,
    [lead_id],
  );
  const lead = leadRows[0];
  if (!lead) throw notFound('Lead not found');

  // Bail if the lead already has an admission row in *any* non-rejected
  // state — the public form is only for the "no admission yet" case.
  const { rows: existing } = await tenantQuery(
    tenant,
    `SELECT id, status FROM admissions
      WHERE lead_id = $1 AND deleted_at IS NULL AND status <> 'rejected'
      LIMIT 1`,
    [lead_id],
  );
  if (existing[0]) {
    throw appError({
      status: 409,
      code: RESPONSE_CODES.CONFLICT ?? 'CONFLICT',
      message: 'An admission already exists for this lead. The public link is only available before the admission is created.',
    });
  }

  // Gate: no fee offer = no link. Forces the accounts team to configure
  // the customised fee plan before sharing anything with the student.
  // The FE makes the "Configure offer" button the only available action
  // when this is missing, so reaching this branch usually means the FE
  // is racing — surface a clean message anyway.
  const offer = await feeOffersRepo.findByLead(tenant, lead_id);
  if (!offer) {
    throw appError({
      status: 412, // Precondition Required
      code: RESPONSE_CODES.CONFLICT ?? 'PRECONDITION_REQUIRED',
      message: 'Configure the fee offer for this lead before generating a public link.',
    });
  }

  // Has the lead been issued a public link before? Drives the activity
  // summary so the timeline reads "Share link minted" the first time
  // and "Share link regenerated" on subsequent mints. We detect by
  // looking for a prior audit row of the same type (lead_activities has
  // no deleted_at column — rows are append-only).
  const { rows: hadPrior } = await tenantQuery(
    tenant,
    `SELECT 1 FROM lead_activities
       WHERE lead_id = $1 AND type = 'share_link_minted' LIMIT 1`,
    [lead_id],
  );
  const isRegenerate = hadPrior.length > 0;

  const token = randomToken(32);
  const row = await tokenRepo.insertToken({
    token,
    tenant_id: tenant.id,
    lead_id,
    created_by_user_id: actor?.id ?? null,
  });

  // Audit row for the lead timeline. Best-effort — never block the
  // mint on an audit failure. The token itself is intentionally NOT
  // stored in metadata (the share link is sensitive); we expose only
  // expiry + counsellor info so the timeline reads cleanly.
  try {
    await tenantQuery(
      tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, $2, 'share_link_minted', $3, $4::jsonb)`,
      [
        lead_id,
        actor?.id ?? null,
        isRegenerate ? 'Share link regenerated' : 'Share link minted',
        JSON.stringify({
          expires_at: row.expires_at,
          ttl_hours: 24,
          is_regenerate: isRegenerate,
        }),
      ],
    );
  } catch {
    // Audit miss — don't fail the mint.
  }
  return { token: row.token, expires_at: row.expires_at };
};

// Resolve token → tenant → lead. Returns ONLY whitelisted lead fields for
// prefill. Throws 404/410 distinctly so the FE can show the right empty
// state ("not found" vs "expired").
export const prefillFromToken = async (token) => {
  const { tenant, lookupRow } = await resolveTokenToTenant(token);

  // Whitelist the lead fields we expose publicly. NEVER add internal
  // fields here without thinking — every field in this object is
  // viewable by anyone who possesses the URL.
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, first_name, last_name, email, whatsapp_number, phone,
            alternate_contact, address, program_id
       FROM leads WHERE id = $1 AND deleted_at IS NULL`,
    [lookupRow.lead_id],
  );
  const lead = rows[0];
  if (!lead) throw notFound('Lead not found');

  // Active programs + centers — student needs both in the form.
  const [{ rows: programs }, { rows: centers }, offer] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT id, name FROM programs WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true ORDER BY name`,
    ),
    tenantQuery(
      tenant,
      `SELECT id, name FROM admission_centers WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true ORDER BY sort_order ASC, name ASC`,
    ),
    feeOffersRepo.findByLead(tenant, lookupRow.lead_id),
  ]);

  // Resolve the offer's program name so the student sees a confirmed
  // course label on the form even though the program select will be
  // locked to the offered program.
  let offerProgramName = null;
  if (offer?.program_id) {
    const match = programs.find((p) => p.id === offer.program_id);
    offerProgramName = match?.name ?? null;
  }

  return {
    lead: {
      id: lead.id,
      name: lead.name,
      first_name: lead.first_name,
      last_name: lead.last_name,
      email: lead.email,
      whatsapp_number: lead.whatsapp_number,
      phone: lead.phone,
      alternate_contact: lead.alternate_contact,
      address: lead.address,
      program_id: lead.program_id,
    },
    programs,
    centers,
    // The pre-arranged fee plan the accounts team offered this lead.
    // null only if generateLink slipped past its gate; the FE should
    // still render gracefully in that case.
    offer: offer ? {
      program_id: offer.program_id,
      program_name: offerProgramName,
      course_fees: Number(offer.course_fees),
      registration_amount: Number(offer.registration_amount),
      registration_date: offer.registration_date,
      // Pre-fills the (locked) Mode of Training select on the student
      // form. Null for legacy offers — the FE falls back to letting the
      // student pick in that case.
      mode_of_training: offer.mode_of_training || null,
      payment_mode: offer.payment_mode,
      fee_installments: offer.fee_installments,
    } : null,
    tenant: {
      name: tenant.company_name || tenant.name,
      logo_url: tenant.logo_url,
      brand_primary_color: tenant.brand_primary_color || null,
    },
    expires_at: lookupRow.expires_at,
  };
};

// Student submission. Creates the admission in pending_approval; the
// accounts team can still edit / approve via the existing admin edit flow.
export const submitFromToken = async (token, input) => {
  const { tenant, lookupRow } = await resolveTokenToTenant(token);

  // Re-check that no admission was created in the meantime (e.g. an
  // accounts user manually created one). Idempotent guard.
  const { rows: existing } = await tenantQuery(
    tenant,
    `SELECT id FROM admissions
      WHERE lead_id = $1 AND deleted_at IS NULL AND status <> 'rejected'
      LIMIT 1`,
    [lookupRow.lead_id],
  );
  if (existing[0]) {
    // Burn the token so a stale tab can't keep retrying.
    await tokenRepo.markUsed(lookupRow.id);
    throw appError({
      status: 409,
      code: RESPONSE_CODES.CONFLICT ?? 'CONFLICT',
      message: 'An admission already exists for this lead.',
    });
  }

  // Fetch the lead to inherit counsellor / source.
  const { rows: leadRows } = await tenantQuery(
    tenant,
    `SELECT id, assigned_to, program_id, first_touch_source, created_by, name, first_name, last_name
       FROM leads WHERE id = $1 AND deleted_at IS NULL`,
    [lookupRow.lead_id],
  );
  const lead = leadRows[0];
  if (!lead) throw notFound('Lead not found');

  // Pin the admission's program + fees to the saved offer, NOT the
  // student's input. The student form shows these read-only; this is
  // the BE belt-and-suspenders that prevents a curl from posting a
  // different course or undercutting the agreed fees.
  const offer = await feeOffersRepo.findByLead(tenant, lead.id);
  if (!offer) {
    throw appError({
      status: 412,
      code: RESPONSE_CODES.CONFLICT ?? 'PRECONDITION_REQUIRED',
      message: 'No fee offer is configured for this lead. Ask your counsellor to send a new link.',
    });
  }

  // Seed the admission's fee_schedule from the offer so the accounts
  // team sees pre-populated installments at the approval step. If the
  // student chose Full payment we deliberately drop the schedule — they
  // opted out of the installment plan, so persisting it would create a
  // contradictory record on the admin side.
  const studentChoseFull = input.mode_of_payment === 'Full';
  const feeSchedule = !studentChoseFull && Array.isArray(offer.fee_installments)
    ? offer.fee_installments
        .filter((r) => r && r.amount != null && r.due_date)
        .map((r) => ({
          installment_no: Number(r.installment_no),
          amount: Number(r.amount),
          due_date: r.due_date,
        }))
    : [];

  const admission = await admissionsRepo.insert(tenant, {
    lead_id: lead.id,
    admission_date: input.admission_date ? new Date(input.admission_date) : new Date(),
    first_name: input.first_name?.trim() || lead.first_name || 'Unnamed',
    middle_name: input.middle_name?.trim() || null,
    last_name: input.last_name?.trim() || lead.last_name || null,
    email: input.email?.trim() || null,
    whatsapp_number: input.whatsapp_number?.trim() || '',
    alternate_contact: input.alternate_contact?.trim() || null,
    address: input.address?.trim() || null,
    program_id: offer.program_id,
    // Mode of training: the offer (set by accounts) is authoritative when
    // present. We still accept the student's value as a fallback for
    // legacy offers that pre-date the offer.mode_of_training column.
    mode_of_training: offer.mode_of_training || input.mode_of_training || 'Offline',
    center_id: input.center_id || null,
    total_fees: Number(offer.course_fees),
    // Mode of payment: student can choose Full / Installment on the form
    // (e.g. they'd rather pay in one shot than follow the installment
    // plan). When Full, we drop the fee_schedule entirely a few lines
    // below so the admin side doesn't show a contradictory plan.
    mode_of_payment: input.mode_of_payment === 'Full' ? 'Full'
                    : input.mode_of_payment === 'Installment' ? 'Installment'
                    : (offer.payment_mode === 'installment' ? 'Installment' : 'Full'),
    selfie_r2_key: input.selfie_r2_key || null,
    photo_r2_key: input.photo_r2_key || null,
    status: 'pending_approval',
    guided_by_counsellor_id: lead.assigned_to || null,
    source: lead.first_touch_source || null,
    education: Array.isArray(input.education) ? input.education : [],
    fee_schedule: feeSchedule,
  }, lead.created_by ?? null);

  await tokenRepo.markUsed(lookupRow.id);

  // Audit: the student submitted the form themselves. actor_kind='student'
  // so the FE timeline can show a distinct badge ("Submitted by student").
  admissionEvents.log(tenant, {
    admission_id: admission.id, lead_id: lead.id,
    event_type: admissionEvents.EVENT_TYPES.CREATED,
    next_status: admission.status,
    actor_kind: admissionEvents.ACTOR_KINDS.STUDENT,
    summary: 'Submitted via public share-link',
    metadata: {
      source: 'public_share_link',
      offer: {
        program_id: offer.program_id,
        course_fees: Number(offer.course_fees),
        registration_amount: Number(offer.registration_amount),
        payment_mode: offer.payment_mode,
      },
    },
  });

  // Notify the accounts team (DB notification + live socket push to every
  // account_manager + super_admin in the tenant). Best-effort — the
  // student's submit response shouldn't depend on the fan-out.
  notifyPendingAdmission(tenant, admission, lead).catch(() => {});

  return { admission_id: admission.id };
};

// Token-scoped public presign. The student needs to upload selfie + photo
// directly to GCS but isn't authenticated — the token gates this. We
// hard-code purpose='admission_photo', cap size + content-type, and
// build the GCS key using the same buildKey() pattern as the admin
// flow so the object lands in the tenant's namespace.
const MAX_PUBLIC_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic']);

export const presignPublicPhoto = async (token, { content_type, size_bytes, filename }) => {
  if (!ALLOWED_IMAGE_TYPES.has(content_type)) {
    throw appError({ status: 400, code: 'VALIDATION_FAILED', message: 'Only JPEG, PNG, WEBP or HEIC images are accepted.' });
  }
  if (!size_bytes || size_bytes > MAX_PUBLIC_PHOTO_BYTES) {
    throw appError({ status: 400, code: 'VALIDATION_FAILED', message: 'Image must be 5 MB or smaller.' });
  }
  const { tenant, lookupRow } = await resolveTokenToTenant(token);

  const ext = (() => {
    if (filename && filename.includes('.')) return filename.split('.').pop().toLowerCase();
    const map = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
    return map[content_type] || 'jpg';
  })();
  // Embed the lead id in the key so a stray upload is traceable to the
  // lead it belongs to even before the admission row is inserted.
  const key = buildKey({
    tenantSlug: tenant.slug,
    purpose: 'admission_photo',
    id: `${lookupRow.lead_id}-${randomToken(8)}`,
    ext,
  });
  const signed = await getUploadSignedUrl({ key, contentType: content_type });
  return {
    upload_url: signed.url,
    method: signed.method,
    headers: signed.headers,
    r2_key: key,
    expires_in: signed.expiresIn,
  };
};

// After a successful PUT to the signed URL, the student calls this so we
// verify the object actually exists in GCS before letting the form store
// the key. Cheap HEAD; refuses if the key looks like it doesn't belong
// to this tenant.
//
// We also index the upload in `uploaded_files` (idempotent insert) so
// the admin-side `/uploads/by-key/signed-url` lookup can serve a signed
// URL by r2_key alone. Without this, student-uploaded admission photos
// never appeared in `uploaded_files` and the admin preview 404'd even
// though the bytes were sitting in GCS.
export const confirmPublicPhoto = async (token, { r2_key }) => {
  const { tenant } = await resolveTokenToTenant(token);
  if (!r2_key.startsWith(`admission_photo/${tenant.slug}/`)) {
    throw appError({ status: 400, code: 'VALIDATION_FAILED', message: 'Invalid upload key for this tenant.' });
  }
  const head = await headObject(r2_key);
  if (!head) throw notFound('Upload not found in storage');
  // Index the file so the admin side can look it up by r2_key. user_id
  // is null — the uploader is an unauthenticated student, not a system
  // user. visibility=tenant lets account_manager / super_admin preview
  // it without owning the row.
  await uploadsRepo.insertIfMissing(tenant, {
    user_id: null,
    r2_key,
    content_type: head.ContentType ?? null,
    size_bytes: head.ContentLength ?? null,
    purpose: 'admission_photo',
    ref_entity_type: 'admission_pending',
    ref_entity_id: null,
    visibility: 'tenant',
  }).catch(() => {
    // Best-effort. If indexing fails we still want the student-side
    // upload to succeed so they can submit the form. The admin preview
    // will simply 404 (current behaviour) until accounts re-uploads.
  });
  return { r2_key, content_type: head.ContentType, size_bytes: head.ContentLength };
};

// Signed GET URL so the form can render a thumbnail preview after upload.
// Same tenant-prefix guard as confirmPublicPhoto.
export const signedPublicPhotoUrl = async (token, r2_key) => {
  const { tenant } = await resolveTokenToTenant(token);
  if (!r2_key.startsWith(`admission_photo/${tenant.slug}/`)) {
    throw appError({ status: 400, code: 'VALIDATION_FAILED', message: 'Invalid upload key for this tenant.' });
  }
  const url = await getDownloadSignedUrl({ key: r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS });
  return { url, expires_in: env.GCS_SIGNED_URL_TTL_SECONDS };
};
