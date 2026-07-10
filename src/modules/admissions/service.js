import * as repo from './repo.js';
import * as tenantsRepo from '../tenants/repo.js';
import { notFound, forbidden } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { tenantQuery } from '../../db/tenant.js';
import { notifyUser } from '../../lib/socket.js';
import { pushNotification } from '../notifications/service.js';
import { logger } from '../../lib/logger.js';
import * as events from './events-repo.js';

// Receipt-number config lives on the system tenants row (see the
// tenant_receipt_config migration). The tenant object threaded through the
// request only carries a subset of columns, so fetch the full row to read
// prefix/start/pad. Returns null (→ legacy RC- numbering) if unavailable.
const getReceiptConfig = async (tenant) => {
  try {
    const t = await tenantsRepo.findById(tenant.id);
    if (!t) return null;
    return { prefix: t.receipt_no_prefix, start: t.receipt_no_start, pad: t.receipt_no_pad };
  } catch {
    return null; // never block receipt creation on a config lookup
  }
};

// Field whitelist for the field_edited audit diff. We only log the
// metadata-meaningful fields; status changes are emitted separately
// via STATUS_CHANGED so don't double-log them here.
const AUDITED_FIELDS = [
  'admission_date', 'first_name', 'middle_name', 'last_name',
  'email', 'whatsapp_number', 'alternate_contact', 'address',
  'program_id', 'mode_of_training', 'center_id',
  'total_fees', 'mode_of_payment',
  'selfie_r2_key', 'photo_r2_key',
  'guided_by_counsellor_id',
];

const buildDiff = (before, patch) => {
  const changed = {};
  for (const k of AUDITED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    const a = before?.[k] ?? null;
    const b = patch[k] ?? null;
    if (String(a) !== String(b)) changed[k] = { from: a, to: b };
  }
  return changed;
};

export const listCenters = (tenant) => repo.listCenters(tenant);
export const createCenter = (tenant, input) => repo.insertCenter(tenant, input);
export const updateCenter = async (tenant, id, patch) => {
  const updated = await repo.updateCenter(tenant, id, patch);
  if (!updated) throw notFound('Center not found');
  return updated;
};
export const deleteCenter = (tenant, id) => repo.softDeleteCenter(tenant, id);

// A counsellor only ever sees admissions for leads THEY own/converted
// (admissions.guided_by_counsellor_id = lead.assigned_to at conversion time).
// account_manager / super_admin see all. Enforced by forcing the filter here
// so a counsellor can't widen it via query params.
const scopeForActor = (q, actor) => {
  if (actor?.role === SYSTEM_TENANT_ROLES.COUNSELLOR) {
    return { ...q, guided_by_counsellor_id: actor.id };
  }
  return q;
};

export const list = (tenant, q, actor) => repo.list(tenant, scopeForActor(q, actor));

export const get = async (tenant, id, actor) => {
  const row = await repo.findByIdWithRelations(tenant, id);
  if (!row) throw notFound('Admission not found');
  // Counsellors can only open their own converted students' admissions.
  if (actor?.role === SYSTEM_TENANT_ROLES.COUNSELLOR && row.guided_by_counsellor_id !== actor.id) {
    throw forbidden('This admission is not in your scope');
  }
  return row;
};

export const create = async (tenant, actor, input) => {
  const row = await repo.insert(tenant, input, actor?.id);
  // Photos uploaded as part of the initial create get their own event so
  // the timeline shows "photo uploaded at create".
  const photoFields = ['selfie_r2_key', 'photo_r2_key'].filter((k) => input[k]);
  events.log(tenant, {
    admission_id: row.id, lead_id: row.lead_id ?? null,
    event_type: events.EVENT_TYPES.CREATED,
    next_status: row.status,
    actor_user_id: actor?.id ?? null,
    actor_kind: events.ACTOR_KINDS.USER,
    summary: 'Admission record created',
    metadata: photoFields.length ? { photos: photoFields } : null,
  });
  return row;
};

// Fields on the admission row that are owned by the fee-offer flow
// rather than the admission edit form. Account managers handle most of
// the admission workflow but are not the source of truth for pricing —
// it lives on lead_fee_offers and is reflected onto programs.course_fees.
// Strip these from any patch coming from an account_manager so a stray
// edit can't overwrite the offer.
const FEE_OWNED_FIELDS = ['total_fees', 'mode_of_payment'];

export const update = async (tenant, id, patch, actor) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Admission not found');
  if (actor?.role === 'account_manager') {
    for (const k of FEE_OWNED_FIELDS) {
      if (k in patch) delete patch[k];
    }
  }
  const row = await repo.updateRow(tenant, id, patch);
  // Diff metadata-fields (status is logged via STATUS_CHANGED below).
  const diff = buildDiff(existing, patch);
  if (Object.keys(diff).length) {
    events.log(tenant, {
      admission_id: id, lead_id: existing.lead_id ?? null,
      event_type: events.EVENT_TYPES.FIELD_EDITED,
      actor_user_id: actor?.id ?? null,
      actor_kind: events.ACTOR_KINDS.USER,
      summary: `Edited ${Object.keys(diff).length} field${Object.keys(diff).length > 1 ? 's' : ''}`,
      metadata: { changes: diff },
    });
  }
  // If the patch changed status separately, emit a STATUS_CHANGED row too.
  if (patch.status && patch.status !== existing.status) {
    events.log(tenant, {
      admission_id: id, lead_id: existing.lead_id ?? null,
      event_type: events.EVENT_TYPES.STATUS_CHANGED,
      prev_status: existing.status,
      next_status: patch.status,
      actor_user_id: actor?.id ?? null,
      actor_kind: events.ACTOR_KINDS.USER,
      summary: `Status: ${existing.status} → ${patch.status}`,
    });
  }
  return row;
};

export const remove = async (tenant, id) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Admission not found');
  await repo.softDelete(tenant, id);
};

export const approve = async (tenant, actor, id) => {
  const existing = await repo.findById(tenant, id);
  const row = await repo.approve(tenant, id, actor?.id);
  if (!row) throw notFound('Admission not found or already approved');
  events.log(tenant, {
    admission_id: id, lead_id: row.lead_id ?? null,
    event_type: events.EVENT_TYPES.STATUS_CHANGED,
    prev_status: existing?.status ?? null,
    next_status: row.status,
    actor_user_id: actor?.id ?? null,
    actor_kind: events.ACTOR_KINDS.USER,
    summary: `Approved · ${existing?.status ?? '—'} → ${row.status}`,
  });

  // Auto-convert the student's submitted registration payment into a real
  // receipt so it flows into the Payments ledger. This is a PARTIAL payment
  // against registration (the agreed registration figure stays on the
  // offer; the receipt records what was actually collected now). Skipped
  // when there's no amount or a registration receipt already exists.
  const paidNow = Number(row.payment_amount || 0);
  if (paidNow > 0) {
    try {
      const already = await repo.hasRegistrationReceipt(tenant, id);
      if (!already) {
        const receiptConfig = await getReceiptConfig(tenant);
        const receipt = await repo.insertReceipt(tenant, id, {
          receipt_date: new Date(),
          amount: paidNow,
          // Student-submitted proofs are UPI/bank transfers; default to
          // 'online' since we don't capture an exact mode on the public form.
          mode_of_payment: 'online',
          transaction_details: row.payment_utr ? `UTR ${row.payment_utr}` : null,
          receipt_kind: 'registration',
          payment_screenshot_r2_key: row.payment_proof_r2_key ?? null,
          payment_account_id: row.payment_account_id ?? null,
        }, actor?.id, receiptConfig);
        events.log(tenant, {
          admission_id: id, lead_id: row.lead_id ?? null,
          event_type: events.EVENT_TYPES.RECEIPT_ADDED,
          actor_user_id: actor?.id ?? null,
          actor_kind: events.ACTOR_KINDS.USER,
          summary: `Registration payment verified · ${paidNow}`,
          metadata: {
            receipt_id: receipt?.id ?? null,
            receipt_no: receipt?.receipt_no ?? null,
            receipt_kind: 'registration',
            auto_from_submission: true,
            share_token: receipt?.share_token ?? null,
          },
        });
      }
    } catch {
      // Never block approval on receipt creation — the accounts user can
      // still add the receipt manually if this fails (e.g. a race that
      // created the registration receipt between the check and insert).
    }
  }

  return row;
};

// Reject a pending admission. Frees the lead to receive a fresh public
// share-link (the link-mint gate excludes rejected rows). The reason —
// if provided — lands in the audit timeline so the next accounts user
// can see why the previous submission was bounced.
export const reject = async (tenant, actor, id, reason) => {
  const existing = await repo.findById(tenant, id);
  const row = await repo.reject(tenant, id, actor?.id);
  if (!row) throw notFound('Admission not found or not pending');
  events.log(tenant, {
    admission_id: id, lead_id: row.lead_id ?? null,
    event_type: events.EVENT_TYPES.STATUS_CHANGED,
    prev_status: existing?.status ?? null,
    next_status: row.status,
    actor_user_id: actor?.id ?? null,
    actor_kind: events.ACTOR_KINDS.USER,
    summary: reason
      ? `Rejected · ${existing?.status ?? '—'} → ${row.status} · ${reason}`
      : `Rejected · ${existing?.status ?? '—'} → ${row.status}`,
    metadata: reason ? { reason } : undefined,
  });
  return row;
};

// Drop a student. Sets status='dropped', records the reason, and — crucially —
// cancels the linked lead's planned follow-ups so the reminder/overdue workers
// stop nagging about a student who's no longer pursuing the course. The lead
// stays converted (it genuinely enrolled once); "dropped" is an accounts-side
// outcome, surfaced in the Drop Candidates tab.
export const drop = async (tenant, actor, id, reason) => {
  const existing = await repo.findById(tenant, id);
  const row = await repo.drop(tenant, id, actor?.id, reason);
  if (!row) throw notFound('Admission not found or already dropped');

  // Stop reminders: cancel any planned follow-ups on the linked lead. We mark
  // them cancelled (not done) so the timeline reads correctly. Best-effort —
  // a failure here must not block the drop.
  if (row.lead_id) {
    try {
      await tenantQuery(
        tenant,
        `UPDATE lead_followups
            SET status = 'cancelled', updated_at = now()
          WHERE lead_id = $1 AND deleted_at IS NULL AND status = 'planned'`,
        [row.lead_id],
      );
    } catch (err) {
      logger.warn({ err: err.message, lead_id: row.lead_id }, 'drop: failed to cancel follow-ups');
    }
  }

  events.log(tenant, {
    admission_id: id, lead_id: row.lead_id ?? null,
    event_type: events.EVENT_TYPES.STATUS_CHANGED,
    prev_status: existing?.status ?? null,
    next_status: row.status,
    actor_user_id: actor?.id ?? null,
    actor_kind: events.ACTOR_KINDS.USER,
    summary: reason
      ? `Dropped · ${existing?.status ?? '—'} → dropped · ${reason}`
      : `Dropped · ${existing?.status ?? '—'} → dropped`,
    metadata: reason ? { reason } : undefined,
  });
  return row;
};

export const setStatus = async (tenant, id, status, extra, actor) => {
  const existing = await repo.findById(tenant, id);
  const row = await repo.setStatus(tenant, id, status, extra);
  if (!row) throw notFound('Admission not found');
  events.log(tenant, {
    admission_id: id, lead_id: row.lead_id ?? null,
    event_type: events.EVENT_TYPES.STATUS_CHANGED,
    prev_status: existing?.status ?? null,
    next_status: row.status,
    actor_user_id: actor?.id ?? null,
    actor_kind: events.ACTOR_KINDS.USER,
    summary: `Status: ${existing?.status ?? '—'} → ${row.status}`,
    metadata: extra && Object.keys(extra).length ? extra : null,
  });
  return row;
};

export const listReceipts = (tenant, q) => repo.listReceipts(tenant, q);

// Admin Payment Details ledger (paginated/filterable/sortable/searchable).
export const listPaymentDetails = (tenant, q) => repo.listPaymentDetails(tenant, q);

// Payment analytics for the admin dashboard charts.
export const paymentAnalytics = (tenant, q) => repo.paymentAnalytics(tenant, q);

export const createReceipt = async (tenant, actor, admission_id, input) => {
  const adm = await repo.findById(tenant, admission_id);
  if (!adm) throw notFound('Admission not found');
  const receiptConfig = await getReceiptConfig(tenant);
  const row = await repo.insertReceipt(tenant, admission_id, input, actor?.id, receiptConfig);
  // Build a friendly summary fragment that names what the money paid for
  // — installment N, registration, or generic — so the audit timeline
  // reads naturally.
  const kindLabel = row.receipt_kind === 'installment'
    ? `Installment ${row.installment_no}`
    : row.receipt_kind === 'registration'
      ? 'Registration'
      : 'Misc';
  events.log(tenant, {
    admission_id, lead_id: adm.lead_id ?? null,
    event_type: events.EVENT_TYPES.RECEIPT_ADDED,
    actor_user_id: actor?.id ?? null,
    actor_kind: events.ACTOR_KINDS.USER,
    summary: `Receipt added · ${kindLabel} · ${input.mode_of_payment || ''} · ${input.amount}`.trim(),
    metadata: {
      receipt_id: row?.id ?? null,
      receipt_no: row?.receipt_no ?? null,
      receipt_kind: row?.receipt_kind ?? null,
      installment_no: row?.installment_no ?? null,
      // Token only — the FE composes the full URL using its own origin so
      // the BE doesn't need to know about dev/prod hostnames.
      share_token: row?.share_token ?? null,
      amount: Number(input.amount),
      mode_of_payment: input.mode_of_payment,
      receipt_date: input.receipt_date,
    },
  });
  return row;
};

export const deleteReceipt = async (tenant, id) => {
  // We need the admission_id BEFORE deletion to attach the event.
  const { rows } = await tenantQuery(
    tenant,
    `SELECT admission_id, receipt_no, amount FROM admission_receipts WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const r = rows[0];
  await repo.deleteReceipt(tenant, id);
  if (r) {
    events.log(tenant, {
      admission_id: r.admission_id,
      event_type: events.EVENT_TYPES.RECEIPT_DELETED,
      actor_kind: events.ACTOR_KINDS.USER,
      summary: `Receipt deleted · ${r.receipt_no || ''} · ${r.amount}`.trim(),
      metadata: { receipt_id: id, receipt_no: r.receipt_no, amount: Number(r.amount) },
    });
  }
};

export const timeline = async (tenant, id, actor) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Admission not found');
  if (actor?.role === SYSTEM_TENANT_ROLES.COUNSELLOR && existing.guided_by_counsellor_id !== actor.id) {
    throw forbidden('This admission is not in your scope');
  }
  return events.listByAdmission(tenant, id);
};

// Lookup helper for the lead drawer's Admission Timeline tab. The lead
// drawer only knows lead.id, so we resolve "what admission belongs to
// this lead" + return its full timeline in one shot. Returns null
// admission_id if the lead has no admission yet (converted but unrouted)
// so the FE can show a friendly empty state instead of a 404.
//
// Also returns the full admission detail (admission form fields, fee
// schedule, education, receipts, and money rollups) so the FE can render
// "Payment details" and "Admission form" sections above the event log
// without a second round-trip.
export const timelineByLead = async (tenant, lead_id, actor) => {
  // Counsellors can only view the admission timeline for their OWN leads.
  if (actor?.role === SYSTEM_TENANT_ROLES.COUNSELLOR) {
    const { rows: own } = await tenantQuery(
      tenant,
      `SELECT 1 FROM leads WHERE id = $1 AND assigned_to = $2 AND deleted_at IS NULL`,
      [lead_id, actor.id],
    );
    if (!own[0]) throw forbidden('This lead is not in your scope');
  }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM admissions
      WHERE lead_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [lead_id],
  );
  const admissionId = rows[0]?.id;
  if (!admissionId) return {
    admission_id: null, admission: null, events: [],
    fee_offer: null, program_fees: null,
    resolved_manager: null, account_manager: null,
  };
  const [admission, list] = await Promise.all([
    repo.findByIdWithRelations(tenant, admissionId),
    events.listByAdmission(tenant, admissionId),
  ]);

  // ---- Fee offer + program catalog fees -------------------------------
  // The Pipeline UI shows "course fees attached to this lead". Order of
  // precedence is: per-lead override (lead_fee_offers row) first, then the
  // program's catalog fees. The FE displays whichever is present and
  // falls back to "Course price is missing" if neither exists.
  const programId = admission?.program_id ?? null;
  const [feeOfferRes, programFeesRes] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT id, lead_id, program_id, course_fees, registration_amount,
              payment_mode, fee_installments, created_at, updated_at
         FROM lead_fee_offers WHERE lead_id = $1 LIMIT 1`,
      [lead_id],
    ),
    programId
      ? tenantQuery(
          tenant,
          `SELECT id, name, code, currency,
                  course_fees, registration_amount,
                  payment_mode, fee_installments
             FROM programs WHERE id = $1 AND deleted_at IS NULL`,
          [programId],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const fee_offer = feeOfferRes.rows[0] ?? null;
  const program_fees = programFeesRes.rows[0] ?? null;

  // ---- Resolved manager (counsellor's manager) ------------------------
  // admissions.guided_by_manager_id is often null because the counsellor
  // is set but their manager is implicit (users.manager_id). Resolve it
  // here so the UI shows the right person without a second round-trip.
  let resolved_manager = null;
  if (admission?.guided_by_manager_id) {
    const { rows: mr } = await tenantQuery(
      tenant,
      `SELECT id, name, email FROM users WHERE id = $1`,
      [admission.guided_by_manager_id],
    );
    resolved_manager = mr[0] ?? null;
  } else if (admission?.guided_by_counsellor_id) {
    const { rows: mr } = await tenantQuery(
      tenant,
      `SELECT m.id, m.name, m.email
         FROM users c
         JOIN users m ON m.id = c.manager_id
        WHERE c.id = $1`,
      [admission.guided_by_counsellor_id],
    );
    resolved_manager = mr[0] ?? null;
  }

  // ---- Account manager attribution -----------------------------------
  // Priority: approved_by (set when the accounts team approves) →
  // created_by IF that user has the accounts role → null. We only return
  // ONE row so the FE can render a single name+email on top.
  let account_manager = null;
  const tryUser = async (uid) => {
    if (!uid) return null;
    const { rows: ur } = await tenantQuery(
      tenant,
      `SELECT id, name, email, role
         FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [uid],
    );
    return ur[0] ?? null;
  };
  const isAccountsRole = (r) => r === 'account_manager' || r === 'super_admin';
  const approver = await tryUser(admission?.approved_by);
  if (approver && isAccountsRole(approver.role)) {
    account_manager = approver;
  } else {
    const creator = await tryUser(admission?.created_by);
    if (creator && isAccountsRole(creator.role)) {
      account_manager = creator;
    }
  }

  return {
    admission_id: admissionId,
    admission,
    events: list,
    fee_offer,
    program_fees,
    resolved_manager,
    account_manager,
  };
};

// Tenant-wide snapshot of every converted lead's admission state.
// Powers the new "Admission Pipeline" sidebar page + the dashboard cards.
export const leadStatusSnapshot = async (tenant) => {
  const { rows: counts } = await tenantQuery(
    tenant,
    `SELECT status, COUNT(*)::int AS count
       FROM admissions WHERE deleted_at IS NULL
       GROUP BY status`,
  );
  // Converted leads without any admission row yet — surfaced as rows
  // (status='unrouted', no admission_id) so the Pipeline table can
  // render them under the "Unrouted" filter chip alongside the real
  // admissions.
  const { rows: unroutedRows } = await tenantQuery(
    tenant,
    `SELECT NULL::uuid          AS admission_id,
            'unrouted'           AS status,
            NULL::timestamptz    AS admission_date,
            NULL::numeric        AS total_fees,
            l.first_name, l.last_name, l.email, l.whatsapp_number,
            l.created_at, l.updated_at,
            l.id                 AS lead_id,
            l.name               AS lead_name,
            l.converted_at,
            p.name               AS program_name,
            NULL::text           AS center_name,
            u.name               AS counsellor_name
       FROM leads l
       LEFT JOIN programs p ON p.id = l.program_id
       LEFT JOIN users    u ON u.id = l.assigned_to
      WHERE l.deleted_at IS NULL
        AND l.converted_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM admissions a
           WHERE a.lead_id = l.id AND a.deleted_at IS NULL
        )
      ORDER BY l.converted_at DESC NULLS LAST
      LIMIT 500`,
  );
  const { rows: list } = await tenantQuery(
    tenant,
    `SELECT a.id AS admission_id, a.status, a.admission_date, a.total_fees,
            a.first_name, a.last_name, a.email, a.whatsapp_number,
            a.created_at, a.updated_at,
            l.id AS lead_id, l.name AS lead_name, l.converted_at,
            p.name AS program_name,
            c.name AS center_name,
            u.name AS counsellor_name
       FROM admissions a
       LEFT JOIN leads             l ON l.id = a.lead_id
       LEFT JOIN programs          p ON p.id = a.program_id
       LEFT JOIN admission_centers c ON c.id = a.center_id
       LEFT JOIN users             u ON u.id = a.guided_by_counsellor_id
      WHERE a.deleted_at IS NULL
      ORDER BY a.updated_at DESC
      LIMIT 500`,
  );
  return {
    counts: counts.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {}),
    unrouted_converted: unroutedRows.length,
    rows: [...list, ...unroutedRows],
  };
};

export const paySchedule = (tenant, q) => repo.paySchedule(tenant, q);
export const collectionReceiptWise = (tenant, q) => repo.collectionReceiptWise(tenant, q);
export const dashboard = (tenant) => repo.dashboard(tenant);

// Counsellor "My Students": their converted leads + submitted admissions,
// scoped to the acting counsellor. (For super_admin/account_manager, who might
// hit this endpoint, fall back to their own id too — but the sidebar surfaces
// it only for counsellors.)
export const myStudents = (tenant, actor) => repo.myStudents(tenant, actor?.id);

export const pendingAdmissions = (tenant) => repo.pendingAdmissions(tenant);
export const pendingAdmissionsCount = (tenant) => repo.pendingAdmissionsCount(tenant);
export const emiDigest = (tenant, upcomingDays) => repo.emiDigest(tenant, upcomingDays);

// Compound dashboard fetch: KPI cards (existing) + 4 chart datasets.
// One round-trip from the FE; ~5 queries server-side run in parallel.
export const dashboardWithCharts = async (tenant, { trend_days = 30 } = {}) => {
  const [kpis, admTrend, colTrend, breakdown, courses] = await Promise.all([
    repo.dashboard(tenant),
    repo.admissionsTrend(tenant, trend_days),
    repo.collectionTrend(tenant, trend_days),
    repo.statusBreakdown(tenant),
    repo.courseBreakdown(tenant),
  ]);
  return {
    ...kpis,
    charts: {
      admissions_trend: admTrend,
      collection_trend: colTrend,
      status_breakdown: breakdown,
      course_breakdown: courses,
      trend_days,
    },
  };
};

// Resolve every active account_manager (+ super_admin) user in the tenant
// so we can fan out a "new pending admission" notification.
const findAccountsAudience = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM users
      WHERE deleted_at IS NULL
        AND is_active = true
        AND role IN ('account_manager', 'super_admin')`,
  );
  return rows.map((r) => r.id);
};

// Fire both a persistent DB notification + a live socket event for every
// account_manager / super_admin. Best-effort; failures don't block the
// admission insert. Exported so public-admissions/service.submitFromToken
// can fire it too — every code path that produces a pending-approval
// admission should notify the accounts team.
export const notifyPendingAdmission = async (tenant, admission, lead) => {
  try {
    const recipients = await findAccountsAudience(tenant);
    const name = lead?.name
      || [admission?.first_name, admission?.last_name].filter(Boolean).join(' ')
      || 'New lead';
    const payload = {
      admission_id: admission?.id || null,
      lead_id: lead?.id || null,
      student_name: name,
      program_id: admission?.program_id || lead?.program_id || null,
    };
    for (const uid of recipients) {
      try {
        await pushNotification(tenant, {
          user_id: uid,
          type: 'admission.pending',
          message: `${name} is ready for admission`,
          metadata_json: payload,
          link: `/accounts/pending-admissions`,
        });
        notifyUser(tenant.id, uid, 'admission.pending', payload);
      } catch (err) {
        logger.warn({ err: err.message, user_id: uid }, 'notify pending-admission failed');
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'pending-admission audience lookup failed');
  }
};

// Auto-create stub admission when a lead transitions into an is_success
// stage. Called from leads/service.changeStage. Idempotent — if an
// admission already exists for the lead, returns the existing one.
export const ensureFromConvertedLead = async (tenant, lead) => {
  if (!lead?.id) return null;
  const { rows: existing } = await tenantQuery(
    tenant,
    `SELECT id FROM admissions WHERE lead_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [lead.id],
  );
  if (existing[0]) return existing[0];
  // Split a single "name" into first/last for the admission row. If the
  // lead already has first/last we use those; otherwise fall back to a
  // naive split on the first space.
  let first = lead.first_name || '';
  let last  = lead.last_name || '';
  if (!first && lead.name) {
    const parts = String(lead.name).trim().split(/\s+/);
    first = parts[0] || lead.name;
    last  = parts.slice(1).join(' ') || '';
  }
  // We deliberately leave whatsapp_number nullable on the DB but the
  // schema requires it; admissions module schema accepts the seeded
  // row even if blank because we bypass zod here. The form will fill
  // in the rest before approval anyway.
  const admission = await repo.insert(tenant, {
    lead_id: lead.id,
    admission_date: new Date(),
    first_name: first || 'Unnamed',
    last_name: last || null,
    email: lead.email || null,
    whatsapp_number: lead.whatsapp_number || lead.phone || '',
    program_id: lead.program_id || null,
    mode_of_training: 'Offline',
    total_fees: 0,
    status: 'pending_approval',
    guided_by_counsellor_id: lead.assigned_to || null,
    source: lead.first_touch_source || null,
  }, lead.created_by);
  // Notify the accounts team (best-effort).
  notifyPendingAdmission(tenant, admission, lead).catch(() => {});
  // Timeline event for the auto-stub creation. actor_kind=system so the
  // FE can distinguish this from a counsellor-driven create.
  events.log(tenant, {
    admission_id: admission.id, lead_id: lead.id,
    event_type: events.EVENT_TYPES.CREATED,
    next_status: admission.status,
    actor_user_id: lead.created_by ?? null,
    actor_kind: events.ACTOR_KINDS.SYSTEM,
    summary: 'Admission stub auto-created when lead converted',
  });
  return admission;
};
