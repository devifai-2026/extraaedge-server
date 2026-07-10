// Resolve a receipt share-token to its public-safe view.
//
// The lookup is tenant-agnostic at the token layer (share tokens are
// globally unique, enforced by a partial unique index). We resolve the
// tenant from the receipt's `admission_id → admissions → tenant` chain
// inside the queries.
import { sysQuery } from '../../db/system.js';
import { resolveTenantById } from '../../db/tenant.js';
import { tenantQuery } from '../../db/tenant.js';
import * as tenantsRepo from '../tenants/repo.js';
import { notFound } from '../../lib/errors.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';

// Since share tokens are tenant-scoped (stored in each tenant DB), we
// have to ask every tenant. In practice this happens rarely (only when
// someone opens a share URL) and tenants are few, so the fan-out cost
// is fine. If it grows, add a system-level token→tenant lookup table.
const findReceiptAcrossTenants = async (token) => {
  const { rows: tenants } = await sysQuery(
    `SELECT id FROM tenants WHERE status = 'active'`,
  );
  for (const t of tenants) {
    const tenant = await resolveTenantById(t.id);
    if (!tenant) continue;
    try {
      const { rows } = await tenantQuery(
        tenant,
        `SELECT r.*, a.id AS adm_id,
                TRIM(COALESCE(a.first_name, '') || ' ' || COALESCE(a.middle_name, '') || ' ' || COALESCE(a.last_name, '')) AS student_name,
                a.admission_date, a.email, a.whatsapp_number, a.alternate_contact,
                a.mode_of_training, a.admission_code,
                p.name AS program_name,
                c.name AS center_name
           FROM admission_receipts r
           JOIN admissions a ON a.id = r.admission_id
           LEFT JOIN programs p ON p.id = a.program_id
           LEFT JOIN admission_centers c ON c.id = a.center_id
          WHERE r.share_token = $1
            AND r.deleted_at IS NULL
          LIMIT 1`,
        [token],
      );
      if (rows[0]) return { tenant, receipt: rows[0] };
    } catch {
      // A tenant lacking the share_token column (e.g. an out-of-date
      // tenant DB) would throw — swallow so the lookup continues.
    }
  }
  return null;
};

// Build the full fee schedule for an admission with Paid/Due status, so the
// public receipt can show the student their whole plan (not just this one
// payment). Registration (if any) is row 0; installments follow. "Paid" = a
// non-deleted receipt exists for that slot.
const buildScheduleWithStatus = async (tenant, admissionId) => {
  if (!admissionId) return { rows: [], totals: { total: 0, paid: 0, due: 0 } };
  const [{ rows: schedule }, { rows: receipts }, { rows: offers }, { rows: adms }] = await Promise.all([
    tenantQuery(tenant, `SELECT installment_no, due_date, amount FROM admission_fee_schedule WHERE admission_id = $1 ORDER BY installment_no`, [admissionId]),
    tenantQuery(tenant, `SELECT receipt_kind, installment_no, amount, receipt_date FROM admission_receipts WHERE admission_id = $1 AND deleted_at IS NULL`, [admissionId]),
    tenantQuery(tenant, `SELECT lfo.registration_amount FROM admissions a JOIN lead_fee_offers lfo ON lfo.lead_id = a.lead_id WHERE a.id = $1 LIMIT 1`, [admissionId]),
    tenantQuery(tenant, `SELECT total_fees FROM admissions WHERE id = $1`, [admissionId]),
  ]);

  // Index receipts: registration + per-installment.
  const regReceipt = receipts.find((x) => x.receipt_kind === 'registration') || null;
  const instReceipts = {};
  for (const x of receipts) {
    if (x.receipt_kind === 'installment' && x.installment_no != null) instReceipts[x.installment_no] = x;
  }

  const rows = [];
  const regAmount = offers[0]?.registration_amount != null ? Number(offers[0].registration_amount) : null;
  if (regAmount != null && regAmount > 0) {
    rows.push({
      label: 'Registration',
      installment_no: null,
      amount: regAmount,
      due_date: null,
      paid: Boolean(regReceipt),
      paid_on: regReceipt?.receipt_date ?? null,
    });
  }
  for (const s of schedule) {
    const rcpt = instReceipts[s.installment_no];
    rows.push({
      label: `Installment ${s.installment_no}`,
      installment_no: s.installment_no,
      amount: Number(s.amount || 0),
      due_date: s.due_date ?? null,
      paid: Boolean(rcpt),
      paid_on: rcpt?.receipt_date ?? null,
    });
  }

  const total = rows.reduce((sum, x) => sum + x.amount, 0)
    || Number(adms[0]?.total_fees || 0);
  const paid = rows.filter((x) => x.paid).reduce((sum, x) => sum + x.amount, 0);
  return { rows, totals: { total, paid, due: Math.max(0, total - paid) } };
};

export const lookupByToken = async (token) => {
  const hit = await findReceiptAcrossTenants(token);
  if (!hit) throw notFound('Receipt not found');
  const { tenant, receipt: r } = hit;
  const fee_schedule = await buildScheduleWithStatus(tenant, r.adm_id);
  // The resolved tenant (from db/tenant cache) carries only a subset of
  // columns. Pull the full system row for the header (address/phone/website)
  // + receipt config (terms lines, signatory label). Best-effort — fall back
  // to the lean object so the receipt still renders if this lookup fails.
  let full = null;
  try { full = await tenantsRepo.findById(tenant.id); } catch { /* use lean tenant */ }
  const t = full || tenant;
  // If accounts attached a payment screenshot when they captured the
  // receipt, mint a signed URL the public page can render inline. The
  // r2_key itself never leaves the server — we hand back a time-limited
  // URL only. Best-effort: a signing failure shouldn't 500 the lookup.
  let payment_screenshot_url = null;
  if (r.payment_screenshot_r2_key) {
    try {
      payment_screenshot_url = await getDownloadSignedUrl({ key: r.payment_screenshot_r2_key });
    } catch { /* swallow — render the receipt without the image */ }
  }
  // Upcoming = unpaid schedule rows that have a due date (the "UPCOMING
  // INSTALLMENT SCHEDULE" table on the receipt shows only what's still owed).
  const upcoming = (fee_schedule.rows || []).filter((row) => !row.paid && row.due_date);
  return {
    receipt: {
      id: r.id,
      receipt_no: r.receipt_no,
      receipt_date: r.receipt_date,
      amount: Number(r.amount),
      mode_of_payment: r.mode_of_payment,
      transaction_details: r.transaction_details,
      receipt_kind: r.receipt_kind,
      installment_no: r.installment_no,
      payment_screenshot_url,
    },
    admission: {
      id: r.adm_id,
      admission_code: r.admission_code,
      student_name: r.student_name || r.email || '—',
      admission_date: r.admission_date,
      program_name: r.program_name,
      center_name: r.center_name,
      mode_of_training: r.mode_of_training,
      // Prefer the WhatsApp number as the contact; fall back to alternate.
      contact: r.whatsapp_number || r.alternate_contact || null,
      email: r.email,
      whatsapp_number: r.whatsapp_number,
    },
    tenant: {
      name: t.company_name || t.brand_name || t.name,
      brand_name: t.brand_name || t.company_name || t.name,
      logo_url: t.logo_url,
      brand_primary_color: t.brand_primary_color || null,
      phone: t.phone || null,
      website: t.website || null,
      email: t.email || null,
      address_line1: t.address_line1 || null,
      address_line2: t.address_line2 || null,
      city: t.city || null,
      state: t.state || null,
      pincode: t.pincode || null,
      currency: t.currency || 'INR',
      // Footer config (defaulted in the migration; safe if the lean row lacks them).
      receipt_terms: Array.isArray(t.receipt_terms) ? t.receipt_terms : [],
      receipt_signatory_label: t.receipt_signatory_label || 'Authorized Signatory',
    },
    // Full plan with Paid/Due per row + totals, so the receipt shows the
    // student their whole schedule, not just this single payment.
    fee_schedule,
    // Only the still-owed installments, for the receipt's upcoming table.
    upcoming,
  };
};
