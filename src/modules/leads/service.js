import * as repo from './repo.js';
import * as usersRepo from '../users/repo.js';
import { duplicateDetected, notFound, forbidden } from '../../lib/errors.js';
import { publish } from '../../lib/queue.js';
import { QUEUE_NAMES, EVENT_TYPES, SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notifyLeadChange, notifyAdmins } from '../../lib/socket.js';
import { applyAssignment, recalcScore } from '../../workers/rule-processor.js';
import { tenantQuery } from '../../db/tenant.js';

const emit = (tenant, type, payload) =>
  publish(QUEUE_NAMES.EVENTS, type, { type, tenantId: tenant.id, occurredAt: new Date().toISOString(), ...payload });

const computeScope = async (tenant, actor) => {
  // counsellor:      own leads only.
  // sales_manager:   team (recursive manager_id) PLUS any unassigned leads
  //                  tagged with their own team_id (so quick-add leads they
  //                  create — which land in Unassigned — still show on
  //                  their dashboard until they're routed to a counsellor).
  // super_admin:     no filter.
  // account_manager: every converted lead in the tenant, regardless of
  //                  owner. They handle post-conversion account work and
  //                  need visibility across the whole converted pipeline.
  if (!actor || !actor.id) return { user_ids: [] };
  if (actor.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) return null;
  if (actor.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
    const [ids, me] = await Promise.all([
      usersRepo.teamHierarchy(tenant, actor.id),
      usersRepo.findById(tenant, actor.id),
    ]);
    return { user_ids: ids, include_unassigned_team_id: me?.team_id ?? null };
  }
  if (actor.role === SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER) {
    return { converted_only: true };
  }
  return { user_ids: [actor.id] };
};

export const listLeads = async (tenant, actor, query) => {
  const scope = await computeScope(tenant, actor);
  return repo.list(tenant, query, scope);
};

export const stageCounts = async (tenant, actor, query = {}) => {
  const scope = await computeScope(tenant, actor);
  return repo.stageCounts(tenant, query, scope);
};

// Bulk auto-assign: runs the active assignment rule against every unassigned
// lead in the tenant. Used by the LeadList "Auto-assign unassigned" button.
// Returns { found, assigned, skipped } so the UI can show a toast.
export const autoAssignUnassigned = async (tenant) => {
  const { rows: leads } = await tenantQuery(
    tenant,
    `SELECT * FROM leads
      WHERE assigned_to IS NULL AND deleted_at IS NULL
      ORDER BY created_at`,
  );
  let assigned = 0;
  let skipped = 0;
  for (const lead of leads) {
    try {
      const r = await applyAssignment(tenant, lead);
      if (r) assigned += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { found: leads.length, assigned, skipped };
};

export const bulkAssign = async (tenant, actor, { lead_ids, filter, assigned_to, reason }) => {
  const scope = await computeScope(tenant, actor);
  const result = await repo.bulkAssign(tenant, {
    lead_ids: lead_ids ?? null,
    filter: filter ?? null,
    assigned_to,
    assigned_by: actor?.id ?? null,
    reason,
    scope,
  });
  for (const id of result.ids) {
    emit(tenant, EVENT_TYPES.LEAD_UPDATED, {
      actorUserId: actor?.id ?? null,
      entityType: 'lead',
      entityId: id,
      payload: { changes: ['assigned_to'], assigned_to, reason: reason ?? null },
    });
    // Real-time push: counsellor receives "lead reassigned to you", their managers
    // and admins also see it. The actor (manager/admin doing the reassign) is
    // excluded from the user-room emit by actor_id but always sees admin-room copies.
    notifyLeadChange({
      tenant,
      lead: { id, assigned_to, name: result.names?.[id] },
      type: 'lead.reassigned',
      actor_id: actor?.id,
      payload: { assigned_to, reason: reason ?? null, count: result.affected },
    }).catch(() => {});
  }
  return result;
};

export const getLead = async (tenant, actor, id) => {
  const row = await repo.findByIdWithRelations(tenant, id);
  if (!row) throw notFound('Lead not found');
  const scope = await computeScope(tenant, actor);
  if (scope) {
    if (scope.converted_only && !row.converted_at) {
      throw forbidden('Lead not in your scope');
    }
    if (scope.user_ids && !scope.user_ids.includes(row.assigned_to) && row.assigned_to !== null) {
      if (actor.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN) throw forbidden('Lead not in your scope');
    }
    // sales_manager extension: unassigned leads on the manager's team are
    // in scope. Without an explicit team_id match an unassigned lead from
    // ANOTHER team would otherwise also slip through because of the
    // assigned_to=null short-circuit above. Tighten that here.
    if (
      scope.user_ids
      && row.assigned_to === null
      && scope.include_unassigned_team_id !== undefined
      && row.team_id !== scope.include_unassigned_team_id
      && actor.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN
    ) {
      throw forbidden('Lead not in your scope');
    }
  }
  return row;
};

// Creator-aware assignment for MANUAL single-lead adds. Routing depends on
// who created the lead (mirrors the bulk-import assignee-resolver rules):
//
//   counsellor    → ALWAYS owns the lead themselves, even if they picked a
//                   different owner in the form. assigned_to is forced to the
//                   creator; manager_id snaps to the creator's manager.
//   sales_manager → round-robin (the tenant's own configured rule/strategy)
//                   across the manager's OWN counsellor team only. Empty team
//                   → leave unassigned, tagged with the manager's team_id so
//                   it surfaces in their Unassigned bucket.
//   super_admin   → the tenant's configured rule across every counsellor in
//                   the tenant (no pool restriction).
//   anything else / no actor → tenant-wide configured rule (legacy default).
//
// Returns true if it fully handled assignment (caller should NOT also run the
// generic applyAssignment), false to fall through to the legacy path.
const assignByCreator = async (tenant, actor, lead) => {
  if (!actor?.id || !actor.role) return false;

  if (actor.role === SYSTEM_TENANT_ROLES.COUNSELLOR) {
    const me = await usersRepo.findById(tenant, actor.id);
    const managerId = me?.manager_id ?? null;
    await tenantQuery(
      tenant,
      `UPDATE leads SET assigned_to = $2, manager_id = $3, last_activity_at = now() WHERE id = $1`,
      [lead.id, actor.id, managerId],
    );
    await tenantQuery(
      tenant,
      `INSERT INTO lead_assignments (lead_id, assigned_to, assignment_type, is_active, status) VALUES ($1,$2,'auto_assign',true,'open')`,
      [lead.id, actor.id],
    );
    await tenantQuery(
      tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, NULL, 'auto_assign', $2, $3::jsonb)`,
      [lead.id, 'Auto-assigned to creator', JSON.stringify({ assigned_to: actor.id, reason: 'counsellor_creator' })],
    );
    return true;
  }

  if (actor.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
    const [teamIds, me] = await Promise.all([
      usersRepo.teamHierarchy(tenant, actor.id),
      usersRepo.findById(tenant, actor.id),
    ]);
    // teamHierarchy includes the manager + any sub-managers; applyAssignment's
    // pickTarget filters the pool down to active counsellors, so passing the
    // full hierarchy is safe.
    const pool = teamIds.filter((id) => id !== actor.id);
    if (!pool.length) {
      // No counsellors under this manager → leave unassigned but stamp the
      // team so it shows in the manager's "Unassigned" dashboard bucket.
      await tenantQuery(
        tenant,
        `UPDATE leads SET team_id = COALESCE(team_id, $2) WHERE id = $1`,
        [lead.id, me?.team_id ?? null],
      );
      return true;
    }
    const r = await applyAssignment(tenant, lead, { restrictPool: pool });
    // If the configured rule matched nobody in the team, fall back to leaving
    // it unassigned under the team rather than leaking to the whole tenant.
    if (!r) {
      await tenantQuery(
        tenant,
        `UPDATE leads SET team_id = COALESCE(team_id, $2) WHERE id = $1`,
        [lead.id, me?.team_id ?? null],
      );
    }
    return true;
  }

  if (actor.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    await applyAssignment(tenant, lead); // tenant-wide pool
    return true;
  }

  return false; // account_manager / unknown → legacy fall-through
};

export const createLead = async (tenant, actor, input, { on_duplicate = 'block', force = false, skip_auto_assign = false } = {}) => {
  if (!force) {
    const dups = await repo.findDuplicates(tenant, {
      phone: input.phone,
      email: input.email,
      whatsapp_number: input.whatsapp_number,
    });
    if (dups.length) {
      if (on_duplicate === 'block') throw duplicateDetected(dups);
      if (on_duplicate === 'warn') {
        // fall through — create anyway, but return matches so caller can act
      }
      // create_new: fall through, caller explicitly accepted
    }
  }
  let lead;
  try {
    lead = await repo.insertLead(tenant, input, actor?.id);
  } catch (err) {
    // The leads_unique_phone_digits partial index (DB backstop) fires when a
    // request races the app-level findDuplicates check above, or when the
    // caller passed force/create_new but the same phone is already live.
    // Surface it as the same friendly 409 the pre-check would have thrown,
    // re-querying for the conflicting row(s) so the FE can show them.
    if (err?.code === '23505' && /leads_unique_phone_digits/.test(err?.constraint ?? err?.message ?? '')) {
      const existing = await repo.findDuplicates(tenant, { phone: input.phone });
      throw duplicateDetected(existing);
    }
    throw err;
  }
  // Quick-add leaves the lead unassigned by skipping the round-robin worker.
  // Admins / managers manually pick an owner from the dashboard's "Unassigned"
  // bucket (filter `assigned_to=null` on /leads).
  if (!skip_auto_assign) {
    // Creator-aware routing (counsellor → self, manager → own team RR, admin →
    // tenant-wide RR). Runs synchronously so the create response and the FE
    // refetch already reflect the assignment. For a counsellor creator this
    // intentionally OVERRIDES any owner they picked in the form — their
    // manually-added leads are always theirs.
    try {
      const handled = await assignByCreator(tenant, actor, lead);
      // Legacy fall-through (no actor / account_manager): only auto-assign
      // when the caller didn't already supply an explicit owner.
      if (!handled && !input.assigned_to) {
        await applyAssignment(tenant, lead);
      }
    } catch {
      // assignment is best-effort — don't block create on rule errors
    }
    // Score the lead synchronously so the create response and the FE refetch
    // both see the rule-derived score. The async LEAD_CREATED worker no
    // longer touches lead_score for this same reason.
    await recalcScore(tenant, lead.id).catch(() => {});
    lead = (await repo.findById(tenant, lead.id)) ?? lead;
    emit(tenant, EVENT_TYPES.LEAD_CREATED, {
      actorUserId: actor?.id ?? null,
      entityType: 'lead',
      entityId: lead.id,
      payload: { lead },
    });
  }
  // Real-time push: who's affected depends on the assignment state.
  //   - assigned at create time (manual single create) → counsellor + their managers
  //   - unassigned (quick add)                          → admins only
  notifyLeadChange({ tenant, lead, type: 'lead.created', actor_id: actor?.id }).catch(() => {});
  return lead;
};

export const updateLead = async (tenant, actor, id, updates) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Lead not found');
  const scope = await computeScope(tenant, actor);
  if (scope && actor.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    if (scope.converted_only && !existing.converted_at) {
      throw forbidden('Lead not in your scope');
    }
    if (scope.user_ids && !scope.user_ids.includes(existing.assigned_to)) {
      // Allow managers to edit unassigned leads on their own team
      // (mirrors the list/getLead widening).
      const isUnassignedOnMyTeam = existing.assigned_to === null
        && scope.include_unassigned_team_id
        && existing.team_id === scope.include_unassigned_team_id;
      if (!isUnassignedOnMyTeam) {
        throw forbidden('Lead not in your scope');
      }
    }
  }
  // Pull `followups` out of the scalar updates — repo.updateLead is for
  // scalar lead columns + family/sources/custom_values; followup edits go
  // through replaceFollowupsForStage so each (lead, stage) group is
  // upserted/soft-deleted atomically.
  const { followups, ...scalarUpdates } = updates ?? {};
  // Pass the actor through so the new stage_changed audit row in
  // repo.updateLead is attributed correctly.
  const lead = await repo.updateLead(tenant, id, scalarUpdates, actor?.id ?? null);

  if (Array.isArray(followups) && followups.length) {
    // Group incoming rows by stage_id. Each group is processed as a full
    // replace for that (lead, stage) — slots not present in the payload
    // get soft-deleted (see replaceFollowupsForStage).
    const byStage = new Map();
    for (const f of followups) {
      if (!f?.stage_id || !Number.isInteger(f.slot_index)) continue;
      if (!byStage.has(f.stage_id)) byStage.set(f.stage_id, []);
      byStage.get(f.stage_id).push(f);
    }
    for (const [stageId, rows] of byStage) {
      await repo.replaceFollowupsForStage(tenant, id, stageId, rows, actor?.id);
    }
  }

  emit(tenant, EVENT_TYPES.LEAD_UPDATED, {
    actorUserId: actor?.id ?? null,
    entityType: 'lead',
    entityId: id,
    payload: { changes: Object.keys(scalarUpdates).concat(followups ? ['followups'] : []) },
  });
  return lead;
};

// Hard-delete the lead and every dependent row (handled by FK CASCADEs).
// Super-admin only — enforced at the route layer.
export const deleteLead = async (tenant, actor, id) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Lead not found');
  await repo.hardDelete(tenant, id);
  emit(tenant, EVENT_TYPES.LEAD_DELETED ?? 'lead.deleted', {
    actorUserId: actor?.id ?? null,
    entityType: 'lead',
    entityId: id,
    payload: { name: existing.name },
  });
};

// Bulk hard-delete. Same cascade behaviour as deleteLead, but takes an array
// of ids and emits one event per actually-deleted row. Super-admin only —
// enforced at the route layer.
//
// We intentionally do NOT pre-check that every id exists before deleting;
// the underlying DELETE is set-based so missing ids are simply no-ops. The
// returned `deleted` count tells the FE how many rows actually went away.
export const bulkDeleteLeads = async (tenant, actor, ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { deleted: 0, deleted_ids: [] };
  }
  const result = await repo.hardDeleteMany(tenant, ids);
  for (const deletedId of result.deleted_ids ?? []) {
    emit(tenant, EVENT_TYPES.LEAD_DELETED ?? 'lead.deleted', {
      actorUserId: actor?.id ?? null,
      entityType: 'lead',
      entityId: deletedId,
      payload: { source: 'bulk_delete' },
    });
  }
  return result;
};

export const changeStage = async (tenant, actor, id, stageChange) => {
  // Capture the outgoing stage BEFORE repo.changeStage flips it — we need it
  // to scope the planned-followup auto-complete sweep.
  const { rows: preRows } = await tenantQuery(
    tenant,
    `SELECT stage_id FROM leads WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const outgoingStageId = preRows[0]?.stage_id ?? null;

  const result = await repo.changeStage(tenant, id, stageChange, actor?.id);
  if (!result) throw notFound('Lead not found');
  // Recompute the score authoritatively so the new stage's `score` column +
  // any matching lead_score_config rules are reflected immediately. The repo
  // intentionally no longer touches lead_score; this is the single source of
  // truth.
  await recalcScore(tenant, id).catch(() => {});

  // When a stage moves, planned follow-ups SCOPED TO THE OUTGOING STAGE
  // become 'done' — moving the lead off that stage means the planned
  // follow-up on that stage is no longer relevant. Followups belonging to
  // other stages are left alone. Ad-hoc planned rows (stage_id NULL) also
  // get completed since they're not tied to any particular stage.
  try {
    const { rows: completed } = await tenantQuery(
      tenant,
      `UPDATE lead_followups
          SET status = 'done', completed_at = now(), completed_by = $2
        WHERE lead_id = $1 AND deleted_at IS NULL AND status = 'planned'
          AND (stage_id = $3 OR stage_id IS NULL)
        RETURNING id`,
      [id, actor?.id ?? null, outgoingStageId],
    );
    for (const f of completed) {
      // Audit trail: drop a timeline activity so reports / the timeline
      // modal can show "follow-up auto-completed because stage moved".
      await tenantQuery(
        tenant,
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
         VALUES ($1, $2, 'follow_up_completed', 'Follow-up auto-completed (stage moved)', $3::jsonb)`,
        [id, actor?.id ?? null, JSON.stringify({ follow_up_id: f.id, reason: 'stage_moved' })],
      );
    }
  } catch {
    // Non-fatal — if the flip fails the stage change still went through;
    // the missed-followup scanner will eventually catch a stale planned row.
  }
  // If the stage change carried a next-action datetime (e.g. lead moved to
  // a "Followup" stage), drop a lead_followups row so it surfaces in the
  // Follow-up Manager for the assigned counsellor. The follow-ups module
  // owns its own list/scope queries; we just write the row here.
  // Skip if the destination stage is is_success (Converted owns no followups).
  if (stageChange.next_action_datetime) {
    const { rows: destStage } = await tenantQuery(
      tenant,
      `SELECT is_success FROM lead_stages WHERE id = $1`,
      [stageChange.stage_id],
    );
    if (destStage[0]?.is_success) {
      // No-op: Converted stage doesn't carry followups.
    } else {
    await tenantQuery(
      tenant,
      `INSERT INTO lead_followups (lead_id, next_action_datetime, comment, stage_id, sub_stage_id, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'planned')`,
      [
        id,
        stageChange.next_action_datetime,
        stageChange.remarks ?? null,
        stageChange.stage_id,
        stageChange.sub_stage_id ?? null,
        actor?.id ?? null,
      ],
    );
    await tenantQuery(
      tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, $2, 'followup_scheduled', 'Follow-up scheduled', $3::jsonb)`,
      [id, actor?.id ?? null, JSON.stringify({ at: stageChange.next_action_datetime })],
    );
    }
  }
  const updated = (await repo.findById(tenant, id)) ?? result;
  emit(tenant, EVENT_TYPES.LEAD_STAGE_CHANGED, {
    actorUserId: actor?.id ?? null,
    entityType: 'lead',
    entityId: id,
    payload: { stage_id: stageChange.stage_id, sub_stage_id: stageChange.sub_stage_id },
  });
  // Real-time: managers + admins of the assigned counsellor see the stage change.
  // The actor (counsellor) is excluded inside notifyLeadChange via actor_id.
  notifyLeadChange({
    tenant,
    lead: updated,
    type: 'lead.stage_changed',
    actor_id: actor?.id,
    payload: { stage_id: stageChange.stage_id, sub_stage_id: stageChange.sub_stage_id },
  }).catch(() => {});

  // Lead conversion no longer auto-creates an admission stub. The
  // public share-link flow is the real seam now:
  //   1. Accounts sees the converted lead in the Pending queue (Source 1
  //      branch of pendingAdmissions — leads with no admission row).
  //   2. They Configure Offer → Copy link → student submits the public
  //      form → THAT creates the admission row with real data.
  //   3. Only THEN does the row flip to "Verify & Approve".
  //
  // The old stub created a confusing intermediate state where accounts
  // saw a "Verify & Approve" CTA on a row that had no submitted data.
  // The ensureFromConvertedLead helper is kept in admissions/service.js
  // for any future re-use (e.g. a one-shot backfill script) but it's no
  // longer invoked from the conversion path.
  return updated;
};

// Unified timeline = activities + notes + messages + calls + admission
// events (so accounts-side actions like "Receipt added", "Status changed
// to attending", "Field edited" surface in the same modal counsellors
// already use).
export const getTimeline = async (tenant, id, { limit = 100, before } = {}) => {
  const params = [id];
  let beforeClause = '';
  if (before) { params.push(before); beforeClause = `AND created_at < $2::timestamptz`; }
  const { rows } = await tenantQuery(
    tenant,
    `WITH events AS (
       (
         SELECT id, 'activity' AS kind, type AS subtype, summary AS body, metadata_json, created_at, user_id
           FROM lead_activities
          WHERE lead_id = $1 ${beforeClause}
       )
       UNION ALL
       (
         SELECT id, 'note' AS kind, visibility AS subtype, body, attachments AS metadata_json, created_at, user_id
           FROM lead_notes WHERE lead_id = $1 AND deleted_at IS NULL ${beforeClause}
       )
       UNION ALL
       (
         SELECT id, 'message' AS kind, channel AS subtype,
                COALESCE(error, status) AS body,
                jsonb_build_object('provider_message_id', provider_message_id, 'template_id', template_id, 'status', status) AS metadata_json,
                COALESCE(sent_at, scheduled_for, delivered_at) AS created_at, user_id
           FROM message_log WHERE lead_id = $1 ${beforeClause.replace('created_at', 'COALESCE(sent_at, scheduled_for, delivered_at)')}
       )
       UNION ALL
       (
         SELECT id, 'call' AS kind, direction AS subtype, remarks AS body,
                jsonb_build_object('status', status, 'duration_seconds', duration_seconds, 'disposition_code', disposition_code, 'recording_r2_key', recording_r2_key) AS metadata_json,
                COALESCE(ended_at, started_at, created_at) AS created_at, user_id
           FROM calls WHERE lead_id = $1 AND deleted_at IS NULL ${beforeClause.replace('created_at', 'COALESCE(ended_at, started_at, created_at)')}
       )
       UNION ALL
       (
         -- Admission events. lead_id is denormalised on the row so we don't
         -- have to chase admissions table. event_type lands in the subtype
         -- column so the FE can switch on it; prev/next status are bundled
         -- into metadata_json alongside whatever the emit-site already wrote.
         SELECT ae.id, 'admission' AS kind, ae.event_type AS subtype,
                ae.summary AS body,
                COALESCE(ae.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'prev_status', ae.prev_status,
                       'next_status', ae.next_status,
                       'actor_kind',  ae.actor_kind
                     ) AS metadata_json,
                ae.occurred_at AS created_at,
                ae.actor_user_id AS user_id
           FROM admission_events ae
          WHERE ae.lead_id = $1 ${beforeClause.replace('created_at', 'ae.occurred_at')}
       )
     )
     SELECT e.*,
            u.name AS user_name,
            -- Resolve stage / sub-stage names so the UI can show "New → Followup"
            -- instead of bare UUIDs.
            sf.name  AS from_stage_name,
            st.name  AS to_stage_name,
            ssf.name AS from_sub_stage_name,
            sst.name AS to_sub_stage_name,
            -- For assignment events, resolve the assignee + their manager
            -- so the timeline can show "Assigned to Foo (foo@bar.com),
            -- reporting to Manager (manager@bar.com)". Reassign events use
            -- 'to' / 'from' in metadata_json; auto-assign / referral use
            -- 'assigned_to'. COALESCE picks whichever shape the row has.
            au.name  AS assignee_name,
            au.email AS assignee_email,
            mu.name  AS assignee_manager_name,
            mu.email AS assignee_manager_email,
            -- For reassign events, the prior owner so the UI can show
            -- "Reassigned from Foo (foo@bar.com) → Bar (bar@bar.com)".
            fu.name  AS from_user_name,
            fu.email AS from_user_email
       FROM events e
       LEFT JOIN users u  ON u.id  = e.user_id
       LEFT JOIN lead_stages     sf  ON e.kind = 'activity' AND e.subtype = 'stage_changed'
                                    AND sf.id  = (e.metadata_json->>'from')::uuid
       LEFT JOIN lead_stages     st  ON e.kind = 'activity' AND e.subtype = 'stage_changed'
                                    AND st.id  = (e.metadata_json->>'to')::uuid
       LEFT JOIN lead_sub_stages ssf ON e.kind = 'activity' AND e.subtype = 'stage_changed'
                                    AND ssf.id = (e.metadata_json->>'from_sub')::uuid
       LEFT JOIN lead_sub_stages sst ON e.kind = 'activity' AND e.subtype = 'stage_changed'
                                    AND sst.id = (e.metadata_json->>'to_sub')::uuid
       LEFT JOIN users au ON e.kind = 'activity'
                         AND e.subtype IN ('assigned', 'reassign', 'auto_assign', 'refer')
                         AND au.id = COALESCE(
                                       (e.metadata_json->>'assigned_to')::uuid,
                                       (e.metadata_json->>'to')::uuid
                                     )
       LEFT JOIN users mu ON au.manager_id = mu.id
       LEFT JOIN users fu ON e.kind = 'activity'
                         AND e.subtype IN ('reassign', 'refer')
                         AND fu.id = (e.metadata_json->>'from')::uuid
      ORDER BY created_at DESC,
               -- Deterministic tiebreaker when two events land on the same
               -- millisecond: keep 'lead_created' last so the post-creation
               -- 'assign' / 'auto_assign' row sorts above it.
               CASE WHEN e.kind = 'activity' AND e.subtype = 'lead_created' THEN 1 ELSE 0 END,
               id DESC
      LIMIT ${Number(limit)}`,
    params,
  );
  return rows;
};

export const updatedAtLoader = async (req) => repo.getUpdatedAt(req.tenant, req.params.id);
