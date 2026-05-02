import * as repo from './repo.js';
import * as usersRepo from '../users/repo.js';
import { duplicateDetected, notFound, forbidden } from '../../lib/errors.js';
import { publish } from '../../lib/queue.js';
import { QUEUE_NAMES, EVENT_TYPES, SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { tenantQuery } from '../../db/tenant.js';

const emit = (tenant, type, payload) =>
  publish(QUEUE_NAMES.EVENTS, type, { type, tenantId: tenant.id, occurredAt: new Date().toISOString(), ...payload });

const computeScope = async (tenant, actor) => {
  // counsellor: own leads only. sales_manager: team (recursive manager_id). super_admin: no filter.
  if (!actor || !actor.id) return { user_ids: [] };
  if (actor.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) return null;
  if (actor.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
    const ids = await usersRepo.teamHierarchy(tenant, actor.id);
    return { user_ids: ids };
  }
  return { user_ids: [actor.id] };
};

export const listLeads = async (tenant, actor, query) => {
  const scope = await computeScope(tenant, actor);
  return repo.list(tenant, query, scope);
};

export const getLead = async (tenant, actor, id) => {
  const row = await repo.findByIdWithRelations(tenant, id);
  if (!row) throw notFound('Lead not found');
  const scope = await computeScope(tenant, actor);
  if (scope && !scope.user_ids.includes(row.assigned_to) && row.assigned_to !== null) {
    // counsellors/managers can only see their scope
    if (actor.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN) throw forbidden('Lead not in your scope');
  }
  return row;
};

export const createLead = async (tenant, actor, input, { on_duplicate = 'block', force = false } = {}) => {
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
  const lead = await repo.insertLead(tenant, input, actor?.id);
  emit(tenant, EVENT_TYPES.LEAD_CREATED, {
    actorUserId: actor?.id ?? null,
    entityType: 'lead',
    entityId: lead.id,
    payload: { lead },
  });
  return lead;
};

export const updateLead = async (tenant, actor, id, updates) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Lead not found');
  const scope = await computeScope(tenant, actor);
  if (scope && !scope.user_ids.includes(existing.assigned_to) && actor.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    throw forbidden('Lead not in your scope');
  }
  const lead = await repo.updateLead(tenant, id, updates);
  emit(tenant, EVENT_TYPES.LEAD_UPDATED, {
    actorUserId: actor?.id ?? null,
    entityType: 'lead',
    entityId: id,
    payload: { changes: Object.keys(updates) },
  });
  return lead;
};

export const deleteLead = async (tenant, actor, id) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Lead not found');
  await repo.softDelete(tenant, id);
};

export const changeStage = async (tenant, actor, id, stageChange) => {
  const updated = await repo.changeStage(tenant, id, stageChange, actor?.id);
  if (!updated) throw notFound('Lead not found');
  emit(tenant, EVENT_TYPES.LEAD_STAGE_CHANGED, {
    actorUserId: actor?.id ?? null,
    entityType: 'lead',
    entityId: id,
    payload: { stage_id: stageChange.stage_id, sub_stage_id: stageChange.sub_stage_id },
  });
  return updated;
};

// Unified timeline = activities + notes + messages + calls, merged by time.
export const getTimeline = async (tenant, id, { limit = 100, before } = {}) => {
  const params = [id];
  let beforeClause = '';
  if (before) { params.push(before); beforeClause = `AND created_at < $2::timestamptz`; }
  const { rows } = await tenantQuery(
    tenant,
    `(
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
     ORDER BY created_at DESC
     LIMIT ${Number(limit)}`,
    params,
  );
  return rows;
};

export const updatedAtLoader = async (req) => repo.getUpdatedAt(req.tenant, req.params.id);
