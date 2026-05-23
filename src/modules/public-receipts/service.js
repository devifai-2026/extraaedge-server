// Resolve a receipt share-token to its public-safe view.
//
// The lookup is tenant-agnostic at the token layer (share tokens are
// globally unique, enforced by a partial unique index). We resolve the
// tenant from the receipt's `admission_id → admissions → tenant` chain
// inside the queries.
import { sysQuery } from '../../db/system.js';
import { resolveTenantById } from '../../db/tenant.js';
import { tenantQuery } from '../../db/tenant.js';
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
                TRIM(COALESCE(a.first_name, '') || ' ' || COALESCE(a.last_name, '')) AS student_name,
                a.admission_date, a.email, a.whatsapp_number,
                p.name AS program_name
           FROM admission_receipts r
           JOIN admissions a ON a.id = r.admission_id
           LEFT JOIN programs p ON p.id = a.program_id
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

export const lookupByToken = async (token) => {
  const hit = await findReceiptAcrossTenants(token);
  if (!hit) throw notFound('Receipt not found');
  const { tenant, receipt: r } = hit;
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
      student_name: r.student_name || r.email || '—',
      admission_date: r.admission_date,
      program_name: r.program_name,
      email: r.email,
      whatsapp_number: r.whatsapp_number,
    },
    tenant: {
      name: tenant.company_name || tenant.name,
      logo_url: tenant.logo_url,
      brand_primary_color: tenant.brand_primary_color || null,
    },
  };
};
