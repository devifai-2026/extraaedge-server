import * as repo from './repo.js';
import * as usersRepo from '../users/repo.js';
import * as leadsRepo from '../leads/repo.js';
import { tenantQuery } from '../../db/tenant.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { DISCOUNT, SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notifyManagersOf, notifyUser } from '../../lib/socket.js';

const { COUNSELLOR_MAX_PERCENT, MAX_PERCENT, STATUS } = DISCOUNT;

// Best-effort timeline audit. Never blocks the discount write.
const audit = async (tenant, lead_id, actor, type, summary, metadata) => {
  try {
    await tenantQuery(
      tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [lead_id, actor?.id ?? null, type, summary, JSON.stringify(metadata ?? {})],
    );
  } catch {
    // audit miss — don't fail the operation
  }
};

export const getForLead = async (tenant, lead_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM leads WHERE id = $1 AND deleted_at IS NULL`,
    [lead_id],
  );
  if (!rows[0]) throw notFound('Lead not found');
  return repo.findByLead(tenant, lead_id);
};

// Whether a given actor applying `pct` would need manager sign-off. A manager
// (sales/branch/super) applying directly IS the approver, so never needs it.
export const discountNeedsApproval = (actor, pct) => {
  const isManager = actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN
    || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER
    || actor?.role === SYSTEM_TENANT_ROLES.SALES_MANAGER;
  return !(pct <= COUNSELLOR_MAX_PERCENT || isManager);
};

// Apply (or re-apply) a discount to a lead.
//   - <= COUNSELLOR_MAX_PERCENT (or a manager actor) → 'approved' immediately.
//   - >  cap by a counsellor                          → 'pending_approval'.
// When this discount is GATING A CONVERSION (the counsellor was moving the lead
// to a converted stage), the caller passes pending_stage_id/pending_sub_stage_id
// so approval can later complete the held stage move. Returns the saved row.
export const applyDiscount = async (tenant, actor, lead_id, { discount_percent, reason, pending_stage_id = null, pending_sub_stage_id = null }) => {
  const pct = Number(discount_percent);
  if (!Number.isFinite(pct) || pct < 0 || pct > MAX_PERCENT) {
    throw validationError({ discount_percent: `must be between 0 and ${MAX_PERCENT}` });
  }

  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name FROM leads WHERE id = $1 AND deleted_at IS NULL`,
    [lead_id],
  );
  if (!rows[0]) throw notFound('Lead not found');
  const leadName = rows[0].name || 'a lead';

  const autoApproved = !discountNeedsApproval(actor, pct);

  const saved = await repo.upsert(tenant, lead_id, {
    discount_percent: pct,
    status: autoApproved ? STATUS.APPROVED : STATUS.PENDING,
    reason: reason ?? null,
    requested_by: actor?.id ?? null,
    approved_by: autoApproved ? (actor?.id ?? null) : null,
    approved_at: autoApproved ? new Date().toISOString() : null,
    // Only a pending discount holds a conversion; an auto-approved one converts
    // inline (handled by the caller), so no held stage is recorded.
    pending_stage_id: autoApproved ? null : pending_stage_id,
    pending_sub_stage_id: autoApproved ? null : pending_sub_stage_id,
  });

  await audit(
    tenant,
    lead_id,
    actor,
    autoApproved ? 'discount_approved' : 'discount_requested',
    autoApproved
      ? `Discount ${pct}% applied`
      : `Discount ${pct}% requested — conversion on hold pending approval`,
    { discount_percent: pct, status: saved.status, auto_approved: autoApproved, cap: COUNSELLOR_MAX_PERCENT, holds_conversion: Boolean(pending_stage_id) && !autoApproved },
  );

  // Real-time: when the discount needs sign-off, notify the requester's
  // managers (sales/branch) + admins so it hits their bell + the Discount
  // Approvals badge updates live.
  if (!autoApproved && actor?.id) {
    notifyManagersOf(tenant, actor.id, 'discount.requested', {
      lead_id,
      lead_name: leadName,
      discount_percent: pct,
      requested_by: actor.id,
      requested_by_name: actor.name ?? null,
      holds_conversion: Boolean(pending_stage_id),
    }).catch(() => {});
  }

  return saved;
};

// Manager decision on a pending discount. `decision` is 'approved' or
// 'rejected'. Only sales_manager / branch_manager / super_admin reach here
// (route-gated); managers can additionally only act on discounts requested by
// someone inside their team subtree.
// `final_percent` (optional) lets the approver grant a different % than
// requested. On APPROVE, if the discount was holding a conversion
// (pending_stage_id), we complete that stage move now — the lead converts only
// after sign-off. On REJECT the lead stays un-converted and the counsellor is
// told why so they can revise.
export const decideDiscount = async (tenant, actor, lead_id, { decision, reject_reason, final_percent }) => {
  const existing = await repo.findByLead(tenant, lead_id);
  if (!existing) throw notFound('No discount on this lead');
  if (existing.status !== STATUS.PENDING) {
    throw validationError({ status: 'Discount is not pending approval' });
  }

  // Team-scoped managers may only decide discounts raised inside their branch
  // subtree. super_admin is unrestricted.
  if (actor?.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    const team = await usersRepo.teamHierarchy(tenant, actor.id); // includes actor + subtree
    if (existing.requested_by && !team.includes(existing.requested_by)) {
      throw forbidden('This discount was requested outside your team');
    }
  }

  if (decision !== STATUS.APPROVED && decision !== STATUS.REJECTED) {
    throw validationError({ decision: 'must be approved or rejected' });
  }

  // Optional edited % (approve only). Validate range; reject ignores it.
  let editedPct = null;
  if (decision === STATUS.APPROVED && final_percent !== undefined && final_percent !== null && final_percent !== '') {
    const p = Number(final_percent);
    if (!Number.isFinite(p) || p < 0 || p > MAX_PERCENT) {
      throw validationError({ final_percent: `must be between 0 and ${MAX_PERCENT}` });
    }
    editedPct = p;
  }
  const finalPct = editedPct ?? Number(existing.discount_percent);
  const heldStageId = existing.pending_stage_id;
  const heldSubStageId = existing.pending_sub_stage_id;

  const updated = await repo.decide(tenant, existing.id, {
    status: decision,
    approved_by: actor?.id ?? null,
    reject_reason: decision === STATUS.REJECTED ? (reject_reason ?? null) : null,
    discount_percent: decision === STATUS.APPROVED ? editedPct : null,
  });

  // On approval, complete the held conversion: move the lead into the stage the
  // counsellor was converting to. (No-op if this discount wasn't gating a
  // conversion — e.g. applied via the standalone endpoint.)
  let converted = false;
  if (decision === STATUS.APPROVED && heldStageId) {
    try {
      await leadsRepo.changeStage(tenant, lead_id, { stage_id: heldStageId, sub_stage_id: heldSubStageId ?? undefined }, actor?.id);
      converted = true;
    } catch (err) {
      // Don't fail the approval if the stage move hiccups; surface in audit.
      converted = false;
    }
  }

  await audit(
    tenant,
    lead_id,
    actor,
    decision === STATUS.APPROVED ? 'discount_approved' : 'discount_rejected',
    decision === STATUS.APPROVED
      ? `Discount ${finalPct}% approved${converted ? ' — lead converted' : ''}${editedPct != null ? ` (adjusted from ${Number(existing.discount_percent)}%)` : ''}`
      : `Discount ${Number(existing.discount_percent)}% rejected`,
    { discount_percent: finalPct, requested_percent: Number(existing.discount_percent), decision, reject_reason: reject_reason ?? null, converted },
  );

  // Real-time: tell the counsellor who requested it of the outcome + final %.
  if (existing.requested_by) {
    notifyUser(tenant.id, existing.requested_by, 'discount.decided', {
      lead_id,
      discount_percent: finalPct,
      requested_percent: Number(existing.discount_percent),
      decision,
      converted,
      reject_reason: decision === STATUS.REJECTED ? (reject_reason ?? null) : null,
    });
  }

  return updated;
};

// Pending-approval queue for the acting manager. super_admin sees the whole
// tenant; sales_manager / branch_manager see only discounts raised inside
// their team subtree.
export const listPending = async (tenant, actor) => {
  if (actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    return repo.listPending(tenant, null);
  }
  const team = await usersRepo.teamHierarchy(tenant, actor.id);
  return repo.listPending(tenant, team);
};
