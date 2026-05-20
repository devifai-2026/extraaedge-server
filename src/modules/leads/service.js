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
  // sales_manager:   team (recursive manager_id).
  // super_admin:     no filter.
  // account_manager: every converted lead in the tenant, regardless of
  //                  owner. They handle post-conversion account work and
  //                  need visibility across the whole converted pipeline.
  if (!actor || !actor.id) return { user_ids: [] };
  if (actor.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) return null;
  if (actor.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
    const ids = await usersRepo.teamHierarchy(tenant, actor.id);
    return { user_ids: ids };
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

export const stageCounts = async (tenant, actor) => {
  const scope = await computeScope(tenant, actor);
  return repo.stageCounts(tenant, scope);
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
  }
  return row;
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
  let lead = await repo.insertLead(tenant, input, actor?.id);
  // Quick-add leaves the lead unassigned by skipping the round-robin worker.
  // Admins / managers manually pick an owner from the dashboard's "Unassigned"
  // bucket (filter `assigned_to=null` on /leads).
  if (!skip_auto_assign) {
    // Run round-robin synchronously when no owner was supplied so the API
    // response already reflects the assignment. The FE refetches the list
    // right after create and was racing the in-process queue otherwise.
    if (!input.assigned_to) {
      try {
        await applyAssignment(tenant, lead);
      } catch {
        // assignment is best-effort — don't block create on rule errors
      }
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
      throw forbidden('Lead not in your scope');
    }
  }
  // Pull `followups` out of the scalar updates — repo.updateLead is for
  // scalar lead columns + family/sources/custom_values; followup edits go
  // through replaceFollowupsForStage so each (lead, stage) group is
  // upserted/soft-deleted atomically.
  const { followups, ...scalarUpdates } = updates ?? {};
  const lead = await repo.updateLead(tenant, id, scalarUpdates);

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

  // Hook: if the lead just landed in an is_success stage, seed a stub
  // admission row so the accounts team sees it under "Pending approval".
  // Lazy import to avoid a circular dep on module load.
  if (updated.converted_at) {
    try {
      const { ensureFromConvertedLead } = await import('../admissions/service.js');
      await ensureFromConvertedLead(tenant, updated);
    } catch {
      // Non-fatal: the lead conversion succeeded regardless; accounts
      // can manually create the admission later if this fails.
    }
  }
  return updated;
};

// Unified timeline = activities + notes + messages + calls, merged by time.
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
                         AND e.subtype = 'reassign'
                         AND fu.id = (e.metadata_json->>'from')::uuid
      ORDER BY created_at DESC
      LIMIT ${Number(limit)}`,
    params,
  );
  return rows;
};

export const updatedAtLoader = async (req) => repo.getUpdatedAt(req.tenant, req.params.id);
