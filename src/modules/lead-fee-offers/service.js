import * as repo from './repo.js';
import * as discountRepo from '../lead-discounts/repo.js';
import { tenantQuery } from '../../db/tenant.js';
import { notFound, forbidden } from '../../lib/errors.js';

// Returns the saved offer for a lead, or null if accounts hasn't
// configured one yet. Also returns the program's defaults so the FE
// modal can prefill its inputs when no offer exists.
export const getForLead = async (tenant, lead_id) => {
  const { rows: leadRows } = await tenantQuery(
    tenant,
    `SELECT id, name, first_name, last_name, email, whatsapp_number,
            converted_at, program_id
       FROM leads WHERE id = $1 AND deleted_at IS NULL`,
    [lead_id],
  );
  const lead = leadRows[0];
  if (!lead) throw notFound('Lead not found');
  if (!lead.converted_at) throw forbidden('Lead has not converted yet — no offer applicable.');

  const offer = await repo.findByLead(tenant, lead_id);

  // The agreed Discount % for the Accounts team. ONLY an APPROVED discount is
  // surfaced — a pending or rejected one must never reach Accounts. (With the
  // hold-conversion model a lead can't even be converted while its discount is
  // pending, so this is belt-and-braces.) Accounts acts on this final %.
  const discountRow = await discountRepo.findByLead(tenant, lead_id);
  const discount = discountRow && discountRow.status === 'approved' ? discountRow : null;

  // Active programs list — the modal lets the manager change the course.
  // We also surface each program's fee defaults so the FE can prefill
  // when the manager picks a different course.
  const { rows: programs } = await tenantQuery(
    tenant,
    `SELECT id, name, course_fees, registration_amount, payment_mode, fee_installments
       FROM programs
      WHERE deleted_at IS NULL AND COALESCE(is_active, true) = true
      ORDER BY name`,
  );

  return { lead, offer, discount, programs };
};

// Create or update the per-lead fee plan. The course is captured in the
// row itself; switching course in the modal is handled FE-side by
// resetting the form before save.
//
// Also drops a `fee_offer_saved` activity onto the lead so the timeline
// reflects the accounts-side pre-admission journey (configure offer →
// send link → student submits). Distinguishes create vs update via the
// pre-existence check so the summary reads naturally.
export const saveOffer = async (tenant, actor, lead_id, body) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, converted_at FROM leads WHERE id = $1 AND deleted_at IS NULL`,
    [lead_id],
  );
  if (!rows[0]) throw notFound('Lead not found');
  if (!rows[0].converted_at) throw forbidden('Lead has not converted yet.');
  const existing = await repo.findByLead(tenant, lead_id);
  const saved = await repo.upsert(tenant, lead_id, body, actor?.id ?? null);

  // Audit row for the lead timeline. Best-effort — a failure here must
  // NOT block the offer save, so we swallow errors. The metadata snapshot
  // lets the FE render a compact "course X · ₹Y" summary inline.
  try {
    await tenantQuery(
      tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, $2, 'fee_offer_saved', $3, $4::jsonb)`,
      [
        lead_id,
        actor?.id ?? null,
        existing ? 'Fee offer updated' : 'Fee offer configured',
        JSON.stringify({
          program_id: saved.program_id,
          course_fees: Number(saved.course_fees),
          registration_amount: Number(saved.registration_amount),
          payment_mode: saved.payment_mode,
          installments_count: Array.isArray(saved.fee_installments)
            ? saved.fee_installments.length
            : 0,
          is_update: Boolean(existing),
        }),
      ],
    );
  } catch {
    // Audit miss — don't fail the offer save.
  }
  return saved;
};
