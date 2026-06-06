// Cross-tenant lead inspection for the product_owner. Resolves a tenant from
// the SYSTEM db, then reads that tenant's db (read-only) reusing the existing
// tenant-side lead repo/service so the "full picture" (details + timeline of
// creation / reassigns / followups + bulk-import origin) matches exactly what
// the tenant app shows.
import { resolveTenantById, tenantQuery, tenantTx } from '../../db/tenant.js';
import * as leadsRepo from '../leads/repo.js';
import * as leadsService from '../leads/service.js';
import { notFound, tenantNotFound, conflict } from '../../lib/errors.js';

const requireTenant = async (tenantId) => {
  const tenant = await resolveTenantById(tenantId);
  if (!tenant) throw tenantNotFound();
  return tenant;
};

// Search leads inside a tenant by name / email / phone / whatsapp.
export const searchLeads = async (tenantId, { q, limit = 25 }) => {
  const tenant = await requireTenant(tenantId);
  const params = [];
  let where = 'l.deleted_at IS NULL';
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    where += ` AND (l.name ILIKE $1 OR l.email::text ILIKE $1 OR l.phone ILIKE $1 OR l.whatsapp_number ILIKE $1)`;
  }
  params.push(Math.min(Number(limit) || 25, 100));
  const { rows } = await tenantQuery(
    tenant,
    `SELECT l.id, l.name, l.email, l.phone, l.whatsapp_number, l.created_at,
            l.assigned_to, u.name AS assigned_to_name, u.email AS assigned_to_email,
            s.name AS stage_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       LEFT JOIN lead_stages s ON s.id = l.stage_id
      WHERE ${where}
      ORDER BY l.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
};

// Build the lead's STAGE JOURNEY: the ordered list of stages it actually
// passed through, with the owner(s) that held it during each stage and any
// reassignments that happened while in that stage. This answers the
// product_owner's "what were the stages, the current stage, and how
// reassignment happened on each stage" question.
//
// We have two independent, timestamped event streams:
//   • stage transitions — `stage_changed` activities (metadata.from/to are
//     stage UUIDs) plus the lead's initial stage at creation.
//   • ownership changes  — `lead_assignments` rows (created_at = when that
//     owner took over).
// Interleaving them chronologically lets us slice ownership per stage window.
const buildStageJourney = async (tenant, lead, timeline) => {
  // 1. Resolve every stage name once (the lead may have visited stages it's
  //    no longer on, and the current stage_id needs a name too).
  const { rows: stageRows } = await tenantQuery(
    tenant,
    `SELECT id, name, order_index, is_success FROM lead_stages ORDER BY order_index`,
  );
  const stageById = new Map(stageRows.map((s) => [s.id, s]));

  // 2. Reconstruct the chronological list of (stage_id, entered_at) segments.
  //    The earliest knowable stage is the `to` of the OLDEST stage_changed
  //    event's `from` (i.e. what it was before the first recorded change). If
  //    there are no stage_changed events, the lead has only ever been on its
  //    current stage_id since creation.
  const stageChanges = timeline
    .filter((t) => t.kind === 'activity' && t.subtype === 'stage_changed' && t.metadata_json?.to)
    .map((t) => ({
      from: t.metadata_json.from ?? null,
      to: t.metadata_json.to,
      at: t.created_at,
      by: t.user_name ?? null,
    }))
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  const segments = [];
  if (stageChanges.length === 0) {
    segments.push({ stage_id: lead.stage_id, entered_at: lead.created_at, by: null });
  } else {
    // The lead started on the `from` of the first transition (fall back to the
    // current stage_id if that's null) at creation time.
    const firstFrom = stageChanges[0].from ?? lead.stage_id;
    segments.push({ stage_id: firstFrom, entered_at: lead.created_at, by: null });
    for (const c of stageChanges) {
      segments.push({ stage_id: c.to, entered_at: c.at, by: c.by });
    }
  }
  // Close each segment with the next segment's entry (or null = still here).
  for (let i = 0; i < segments.length; i += 1) {
    segments[i].left_at = segments[i + 1]?.entered_at ?? null;
    segments[i].is_current = i === segments.length - 1;
  }

  // 3. Ownership events, oldest first. Each lead_assignments row is "owner X
  //    became active at created_at". Slice them into each stage window.
  const owners = [...(lead.assignments || [])]
    .map((a) => ({
      assigned_to: a.assigned_to,
      assigned_to_name: a.assigned_to_name,
      assigned_to_email: a.assigned_to_email,
      from_user_name: a.from_user_name,
      assigned_by_name: a.assigned_by_name,
      auto: a.assigned_by == null,
      assignment_type: a.assignment_type,
      reason: a.reason,
      at: a.created_at,
    }))
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  // 4. Stitch: for each stage segment, attach the owners whose change-time
  //    falls inside [entered_at, left_at), plus the owner that was already
  //    active when the segment opened (carried over from the prior stage).
  let carried = null;
  const journey = segments.map((seg) => {
    const segStart = new Date(seg.entered_at);
    const segEnd = seg.left_at ? new Date(seg.left_at) : null;
    const within = owners.filter((o) => {
      const t = new Date(o.at);
      return t >= segStart && (segEnd == null || t < segEnd);
    });
    // Owners active during this stage = whoever was carried in + any that
    // changed while in this stage.
    const ownersInStage = [];
    if (carried) ownersInStage.push({ ...carried, carried_over: true });
    for (const o of within) ownersInStage.push({ ...o, carried_over: false });
    // The owner active at the END of this segment carries into the next.
    if (within.length) carried = within[within.length - 1];
    else if (!carried && owners.length) carried = owners[0];

    const stage = stageById.get(seg.stage_id) || null;
    return {
      stage_id: seg.stage_id,
      stage_name: stage?.name ?? null,
      order_index: stage?.order_index ?? null,
      is_success: stage?.is_success ?? null,
      entered_at: seg.entered_at,
      left_at: seg.left_at,
      is_current: seg.is_current,
      moved_by: seg.by,
      // Reassignments that happened WHILE in this stage (exclude the carried
      // owner, which is a continuation not a new assignment in this stage).
      owners: ownersInStage,
      reassignments_in_stage: within.length,
    };
  });

  return {
    stages: stageRows.map((s) => ({ id: s.id, name: s.name, order_index: s.order_index, is_success: s.is_success })),
    current_stage: stageById.get(lead.stage_id)
      ? { id: lead.stage_id, name: stageById.get(lead.stage_id).name, order_index: stageById.get(lead.stage_id).order_index, is_success: stageById.get(lead.stage_id).is_success }
      : null,
    journey,
  };
};

// Pull EVERY per-lead table verbatim so the product_owner sees the complete
// A-to-Z record with nothing hidden. findByIdWithRelations only surfaces the
// "card" relations (family, sources, tags, custom values, assignments,
// followups); this fills in the rest — communications, calls, payments,
// admissions, referrals, duplicates, merges, SLA, opt-ins, etc.
//
// Each query is independent and best-effort: a table that doesn't exist for a
// given tenant (older schema) or returns an error must NOT blow up the whole
// inspector, so every fetch is wrapped and degrades to []. Raw rows are
// returned as-is (no column whitelist) deliberately — this is the cross-tenant
// PRODUCT_OWNER inspector and the explicit goal is "nothing hidden".
const safeRows = async (tenant, sql, params = []) => {
  try {
    const { rows } = await tenantQuery(tenant, sql, params);
    return rows;
  } catch {
    return [];
  }
};

const getRelated = async (tenant, leadId) => {
  // Tables keyed directly by lead_id — fetch raw, newest-first where the
  // table has a created_at (most do). Use LIMIT to stay sane on chatty tables.
  const byLead = async (table, order = 'created_at DESC', limit = 500) =>
    safeRows(tenant, `SELECT * FROM ${table} WHERE lead_id = $1 ORDER BY ${order} LIMIT ${limit}`, [leadId]);

  const [
    notes, calls, callRecordings, messages, messageReplies, touches,
    optins, suppressions, slaAlerts, referralCodes, referralCredits,
    payments, paymentLinks, paymentAttributions, webhookDeliveries,
    feeOffer, admissions, mergeLog,
  ] = await Promise.all([
    byLead('lead_notes', 'created_at DESC'),
    byLead('calls', 'COALESCE(ended_at, started_at, created_at) DESC'),
    byLead('lead_call_recordings', 'created_at DESC'),
    byLead('message_log', 'COALESCE(sent_at, scheduled_for, created_at) DESC'),
    byLead('message_reply', 'created_at DESC'),
    byLead('lead_touches', 'created_at DESC'),
    byLead('optin_log', 'created_at DESC'),
    byLead('suppression_list', 'created_at DESC'),
    byLead('sla_alerts', 'created_at DESC'),
    byLead('lead_referral_codes', 'created_at DESC'),
    byLead('referral_credits', 'created_at DESC'),
    byLead('payments', 'created_at DESC'),
    byLead('payment_links', 'created_at DESC'),
    byLead('payment_attributions', 'created_at DESC'),
    byLead('outbound_webhook_deliveries', 'created_at DESC'),
    safeRows(tenant, `SELECT * FROM lead_fee_offers WHERE lead_id = $1`, [leadId]),
    safeRows(tenant, `SELECT * FROM admissions WHERE lead_id = $1 ORDER BY created_at DESC`, [leadId]),
    safeRows(tenant, `SELECT * FROM lead_merge_log WHERE lead_id = $1 ORDER BY created_at DESC`, [leadId]),
  ]);

  // Duplicate matches: lead can be on either side of the pair.
  const duplicateMatches = await safeRows(
    tenant,
    `SELECT dm.*,
            la.name AS lead_a_name, lb.name AS lead_b_name
       FROM lead_duplicate_matches dm
       LEFT JOIN leads la ON la.id = dm.lead_a_id
       LEFT JOIN leads lb ON lb.id = dm.lead_b_id
      WHERE dm.lead_a_id = $1 OR dm.lead_b_id = $1
      ORDER BY dm.created_at DESC LIMIT 200`,
    [leadId],
  );

  // Admission children (receipts / fee schedule / education / events) hang off
  // admission_id, so resolve them per admission the lead has.
  const admissionIds = admissions.map((a) => a.id);
  let admissionReceipts = [], admissionFeeSchedule = [], admissionEducation = [], admissionEvents = [];
  if (admissionIds.length) {
    [admissionReceipts, admissionFeeSchedule, admissionEducation] = await Promise.all([
      safeRows(tenant, `SELECT * FROM admission_receipts WHERE admission_id = ANY($1::uuid[]) ORDER BY created_at DESC`, [admissionIds]),
      safeRows(tenant, `SELECT * FROM admission_fee_schedule WHERE admission_id = ANY($1::uuid[]) ORDER BY due_date`, [admissionIds]),
      safeRows(tenant, `SELECT * FROM admission_education WHERE admission_id = ANY($1::uuid[])`, [admissionIds]),
    ]);
  }
  admissionEvents = await safeRows(tenant, `SELECT * FROM admission_events WHERE lead_id = $1 ORDER BY occurred_at DESC LIMIT 500`, [leadId]);

  return {
    notes, calls, call_recordings: callRecordings,
    messages, message_replies: messageReplies, touches,
    optins, suppressions, sla_alerts: slaAlerts,
    referral_codes: referralCodes, referral_credits: referralCredits,
    payments, payment_links: paymentLinks, payment_attributions: paymentAttributions,
    outbound_webhook_deliveries: webhookDeliveries,
    fee_offer: feeOffer[0] ?? null,
    duplicate_matches: duplicateMatches,
    merge_log: mergeLog,
    admissions: admissions.map((a) => ({
      ...a,
      receipts: admissionReceipts.filter((r) => r.admission_id === a.id),
      fee_schedule: admissionFeeSchedule.filter((r) => r.admission_id === a.id),
      education: admissionEducation.filter((r) => r.admission_id === a.id),
    })),
    admission_events: admissionEvents,
  };
};

// Find OTHER lead records for the same person (same phone last-10-digits, or
// same email, or same whatsapp) — i.e. duplicate leads. This is the answer to
// "the lead I moved to Sakshi shows a different owner now": a re-import or
// manual re-create can spawn a SECOND lead row, and the stage/owner history
// you remember lives on the sibling, not the one you happened to open. Each
// sibling carries its current stage + owner + a one-line ownership summary so
// the product_owner can spot "ah, Sakshi owns the OTHER copy".
const getSiblingLeads = async (tenant, lead) => {
  const conds = [];
  const params = [lead.id];
  if (lead.phone) { params.push(lead.phone); conds.push(`RIGHT(regexp_replace(l.phone, '\\D', '', 'g'), 10) = RIGHT(regexp_replace($${params.length}, '\\D', '', 'g'), 10)`); }
  if (lead.email) { params.push(lead.email); conds.push(`l.email = $${params.length}::citext`); }
  if (lead.whatsapp_number) { params.push(lead.whatsapp_number); conds.push(`RIGHT(regexp_replace(l.whatsapp_number, '\\D', '', 'g'), 10) = RIGHT(regexp_replace($${params.length}, '\\D', '', 'g'), 10)`); }
  if (!conds.length) return [];
  return safeRows(
    tenant,
    `SELECT l.id, l.name, l.email, l.phone, l.whatsapp_number, l.created_at,
            l.created_by, l.deleted_at, l.merged_into_id,
            s.name AS stage_name,
            u.name AS owner_name, u.email AS owner_email,
            (SELECT count(*) FROM lead_assignments la WHERE la.lead_id = l.id) AS assignment_count
       FROM leads l
       LEFT JOIN lead_stages s ON s.id = l.stage_id
       LEFT JOIN users u ON u.id = l.assigned_to
      WHERE l.id <> $1 AND (${conds.join(' OR ')})
      ORDER BY l.created_at DESC
      LIMIT 50`,
    params,
  );
};

// Full lead: scalar + relations (family, sources, assignment history,
// followups) AND the activity timeline (creation, reassigns, followups, etc.).
export const getLeadFull = async (tenantId, leadId) => {
  const tenant = await requireTenant(tenantId);
  const lead = await leadsRepo.findByIdWithRelations(tenant, leadId);
  if (!lead) throw notFound('Lead not found');
  const timeline = await leadsService.getTimeline(tenant, leadId, { limit: 200 });
  const [stage_journey, related, siblings] = await Promise.all([
    buildStageJourney(tenant, lead, timeline),
    getRelated(tenant, leadId),
    getSiblingLeads(tenant, lead),
  ]);

  // Resolve the creator (the lead repo returns created_by uuid but not the
  // name/email) so the product_owner can see WHO added the lead.
  let creator = null;
  if (lead.created_by) {
    const { rows } = await tenantQuery(
      tenant,
      `SELECT id, name, email, role FROM users WHERE id = $1`,
      [lead.created_by],
    );
    creator = rows[0] ?? null;
  }

  // Derive a clear "origin" summary from the lead_created activity:
  //   metadata_json.source === 'bulk_import'  → came from a bulk upload
  //   metadata_json.source === 'api' / other  → added manually (single create)
  // and whether the first assignment was system auto-assigned vs done by a
  // person (assigned_by NULL === system/rule-engine).
  const createdEvt = timeline.find((t) => t.kind === 'activity' && t.subtype === 'lead_created');
  const source = createdEvt?.metadata_json?.source ?? null;
  const firstAssign = [...(lead.assignments || [])].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at),
  )[0] ?? null;
  const origin = {
    created_by_id: lead.created_by ?? null,
    created_by_name: creator?.name ?? null,
    created_by_email: creator?.email ?? null,
    created_by_role: creator?.role ?? null,
    created_at: lead.created_at,
    source,                                   // 'bulk_import' | 'api' | null
    via: source === 'bulk_import' ? 'bulk_upload' : (lead.created_by ? 'manual' : 'unknown'),
    first_assignment_type: firstAssign?.assignment_type ?? null,
    first_assigned_auto: firstAssign ? firstAssign.assigned_by == null : null,
  };

  return { tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name }, lead, timeline, origin, stage_journey, related, siblings };
};

// Restore a soft-deleted / merged-away lead and retire the live duplicate(s)
// that are blocking it. This is the recovery for "the lead I worked to
// Qualified got auto-deleted by the oldest-wins phone-dedup, leaving the New
// stub live". In ONE transaction:
//   1. Un-delete the target (deleted_at = NULL, merged_into_id = NULL).
//   2. Soft-delete every OTHER currently-live lead that shares the target's
//      normalised phone — otherwise the leads_unique_phone_digits partial
//      unique index rejects the un-delete. The retired stub stays recoverable.
//   3. Audit both sides on lead_activities so the timeline records the swap.
// Returns the restored lead + the ids retired to make room.
export const restoreLead = async (tenantId, leadId, actor) => {
  const tenant = await requireTenant(tenantId);
  return tenantTx(tenant, async (client) => {
    const { rows: targetRows } = await client.query(
      `SELECT id, name, phone, deleted_at, merged_into_id FROM leads WHERE id = $1`,
      [leadId],
    );
    const target = targetRows[0];
    if (!target) throw notFound('Lead not found');
    if (!target.deleted_at && !target.merged_into_id) {
      throw conflict('Lead is already live — nothing to restore.');
    }

    // Find live leads that would collide on the phone-unique index.
    let retiredIds = [];
    if (target.phone) {
      const { rows: conflicts } = await client.query(
        `SELECT id FROM leads
          WHERE id <> $1
            AND deleted_at IS NULL
            AND RIGHT(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10)
              = RIGHT(regexp_replace($2, '\\D', '', 'g'), 10)
            AND length(RIGHT(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10)) = 10`,
        [leadId, target.phone],
      );
      retiredIds = conflicts.map((c) => c.id);
      if (retiredIds.length) {
        await client.query(
          `UPDATE leads SET deleted_at = now() WHERE id = ANY($1::uuid[])`,
          [retiredIds],
        );
        for (const rid of retiredIds) {
          // user_id stays NULL: the actor is a PLATFORM user (product_owner),
          // not a tenant `users` row, so it can't satisfy the user_id FK. The
          // platform actor is recorded in metadata_json instead.
          await client.query(
            `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
             VALUES ($1,NULL,'lead_retired',$2,$3::jsonb)`,
            [rid, 'Retired by product_owner to restore the original lead',
             JSON.stringify({ restored_lead_id: leadId, by_platform_user_id: actor?.id ?? null, by_platform_user: actor?.email ?? null })],
          );
        }
      }
    }

    // Bring the target back.
    await client.query(
      `UPDATE leads SET deleted_at = NULL, merged_into_id = NULL, last_activity_at = now() WHERE id = $1`,
      [leadId],
    );
    await client.query(
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1,NULL,'lead_restored',$2,$3::jsonb)`,
      [leadId, 'Restored by product_owner',
       JSON.stringify({ retired_lead_ids: retiredIds, by_platform_user_id: actor?.id ?? null, by_platform_user: actor?.email ?? null })],
    );

    return { restored_lead_id: leadId, retired_lead_ids: retiredIds };
  });
};

// Bulk imports for a tenant (status, file, row counts) — the product_owner's
// window into "the bulk upload that failed".
export const listBulkImports = async (tenantId, { limit = 50 }) => {
  const tenant = await requireTenant(tenantId);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT bi.id, bi.created_at, bi.started_at, bi.completed_at, bi.status,
            bi.duplicate_handling, bi.total_rows, bi.success_rows, bi.failed_rows,
            bi.duplicate_rows, bi.file_name, bi.file_r2_key, bi.source,
            u.name AS by_name, u.email AS by_email
       FROM bulk_imports bi
       LEFT JOIN users u ON u.id = bi.user_id
      ORDER BY bi.created_at DESC
      LIMIT $1`,
    [Math.min(Number(limit) || 50, 200)],
  );
  return { tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name }, imports: rows };
};

// Detail of one bulk import + its failure rows (why each row failed) so the
// product_owner can answer "which rows failed and why".
export const getBulkImport = async (tenantId, importId) => {
  const tenant = await requireTenant(tenantId);
  const { rows: imp } = await tenantQuery(
    tenant,
    `SELECT bi.*, u.name AS by_name, u.email AS by_email
       FROM bulk_imports bi LEFT JOIN users u ON u.id = bi.user_id
      WHERE bi.id = $1`,
    [importId],
  );
  if (!imp[0]) throw notFound('Bulk import not found');
  const { rows: failures } = await tenantQuery(
    tenant,
    `SELECT row_number, raw_row_json, error_code, error_message, retried_at, retry_import_id
       FROM bulk_import_failures WHERE import_id = $1 ORDER BY row_number LIMIT 1000`,
    [importId],
  );
  return { import: imp[0], failures };
};
