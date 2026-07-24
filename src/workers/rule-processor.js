import { registerWorker, publish } from '../lib/queue.js';
import { QUEUE_NAMES, EVENT_TYPES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { evaluateCondition, materializeActions } from '../services/rule-engine.js';
import { logger } from '../lib/logger.js';

// Assignment + scoring + generic rules engine.
// Subscribes to the events queue (global) and fires matching rules.
registerWorker(QUEUE_NAMES.EVENTS, async ({ data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;
  try {
    // Auto-assignment + lead scoring on create both moved to the service
    // layer (createLead) so the API response already reflects them — the
    // FE refetch right after create was racing this worker. LEAD_CREATED
    // is still emitted so generic rules below can react to it.

    // Generic rules — look up by event type
    const { rows: rules } = await tenantQuery(
      tenant,
      `SELECT * FROM rules WHERE is_active AND deleted_at IS NULL AND $1 = ANY(event_types) ORDER BY priority`,
      [data.type],
    );
    if (rules.length) {
      // Load lead if this is lead-centric
      const { rows: [lead] } = data.payload?.lead?.id || data.entityType === 'lead'
        ? await tenantQuery(tenant, `SELECT * FROM leads WHERE id = $1`, [data.payload?.lead?.id ?? data.entityId])
        : { rows: [null] };
      const ctx = { event: data, lead };
      for (const rule of rules) {
        if (!evaluateCondition(rule.condition_json, ctx)) continue;
        const actions = materializeActions(rule.action_json ?? [], ctx);
        for (const a of actions) {
          // Automated WhatsApp is disabled (per-user manual chat only) — skip
          // any send_message action targeting WhatsApp.
          if (a.type === 'send_message' && a.channel === 'whatsapp') continue;
          if (a.type === 'send_message' && lead && a.channel && a.template_id) {
            const { rows: [log] } = await tenantQuery(
              tenant,
              `INSERT INTO message_log (lead_id, channel, template_id, recipient, provider, status)
               VALUES ($1,$2,$3,$4,$5,'queued') RETURNING id`,
              [lead.id, a.channel, a.template_id, lead[a.channel === 'email' ? 'email' : 'phone'], a.channel === 'email' ? 'brevo' : 'messagecentral'],
            );
            const qname = a.channel === 'email' ? QUEUE_NAMES.EMAIL : QUEUE_NAMES.SMS;
            await publish(qname, 'send', { tenantId: tenant.id, message_log_id: log.id, lead_id: lead.id, template_id: a.template_id });
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'rule-processor failed');
  }
}, { concurrency: 4, jobName: '*' });

// Assignment-rules engine — picks the first matching rule and applies its
// strategy. Exported so the leads service can run it on-demand for bulk
// "auto-assign all unassigned" operations triggered from the UI.
// `restrictPool`, when passed, is an array of user ids the assignment must
// stay within (e.g. a manager's own counsellor team for a manager-created
// lead). The tenant's configured rule + strategy still decide *how* to pick;
// the pool only narrows *who* is eligible. Omit it (default) for the
// tenant-wide behaviour used by admin creates and the bulk "auto-assign
// unassigned" button.
export const applyAssignment = async (tenant, lead, { restrictPool = null, allowReassign = false } = {}) => {
  // GUARD: never silently re-route a lead that already has an owner. This
  // function unconditionally overwrote assigned_to, so ANY path that reached
  // it with a live lead (queue replay after a restart, a rule fired on an
  // update event, a bulk sweep) would rip the lead away from its counsellor.
  // Re-read ownership from the DB rather than trusting the (possibly stale)
  // `lead` snapshot the caller passed. Callers that legitimately reassign
  // (manual transfer, "reassign all in team") must opt in with allowReassign.
  if (!allowReassign) {
    const { rows: [cur] } = await tenantQuery(tenant, `SELECT assigned_to FROM leads WHERE id = $1`, [lead.id]);
    if (cur?.assigned_to) return null; // already owned → no-op, keep the owner
  }
  const { rows: rules } = await tenantQuery(tenant, `SELECT * FROM assignment_rules WHERE is_active AND deleted_at IS NULL ORDER BY priority`);
  for (const rule of rules) {
    if (!evaluateCondition(rule.condition_json, { lead })) continue;
    const targetUser = await pickTarget(tenant, rule, restrictPool);
    if (!targetUser) continue;
    // Snap manager_id + branch_id to the new counsellor so the hierarchy chip
    // on the LeadCard and branch scoping reflect reality. Mirrors the manual
    // reassign path in modules/lead-assignments.
    const { rows: mgrRows } = await tenantQuery(
      tenant,
      `SELECT manager_id, branch_id FROM users WHERE id = $1`,
      [targetUser],
    );
    const newManagerId = mgrRows[0]?.manager_id ?? null;
    const newBranchId = mgrRows[0]?.branch_id ?? null;
    await tenantQuery(
      tenant,
      `UPDATE leads SET assigned_to = $2, manager_id = $3, branch_id = $4, last_activity_at = now() WHERE id = $1`,
      [lead.id, targetUser, newManagerId, newBranchId],
    );
    await tenantQuery(tenant, `INSERT INTO lead_assignments (lead_id, assigned_to, assignment_type, is_active, status) VALUES ($1,$2,'auto_assign',true,'open')`, [lead.id, targetUser]);
    // Timeline visibility: also drop a row in lead_activities so the
    // "Counselor Activity" filter on the timeline modal sees this event.
    await tenantQuery(
      tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, NULL, 'auto_assign', $2, $3::jsonb)`,
      [lead.id, 'Auto-assigned by rule', JSON.stringify({ assigned_to: targetUser, rule_id: rule.id })],
    );
    await tenantQuery(tenant, `UPDATE assignment_rule_state SET last_assigned_user_id = $2, last_assigned_at = now(), total_assignments = total_assignments + 1 WHERE rule_id = $1`, [rule.id, targetUser]);
    await publish(QUEUE_NAMES.EVENTS, EVENT_TYPES.LEAD_ASSIGNED, {
      type: EVENT_TYPES.LEAD_ASSIGNED,
      tenantId: tenant.id,
      occurredAt: new Date().toISOString(),
      entityType: 'lead',
      entityId: lead.id,
      payload: { assigned_to: targetUser, rule_id: rule.id },
    });
    // Real-time push to the counsellor + their managers + admins.
    const { notifyLeadChange } = await import('../lib/socket.js');
    notifyLeadChange({
      tenant,
      lead: { id: lead.id, name: lead.name, assigned_to: targetUser },
      type: 'lead.assigned',
      actor_id: null,
      payload: { rule_id: rule.id, auto: true },
    }).catch(() => {});
    return { assigned_to: targetUser, rule_id: rule.id };
  }
  return null; // no rule matched → caller treats as "no-op"
};

const pickTarget = async (tenant, rule, restrictPool = null) => {
  const candidates = [];
  if (rule.target_team_id) {
    const { rows } = await tenantQuery(tenant, `SELECT user_id FROM team_members WHERE team_id = $1`, [rule.target_team_id]);
    candidates.push(...rows.map((r) => r.user_id));
  }
  if (rule.target_users) candidates.push(...rule.target_users);

  // Filter candidates down to ACTIVE COUNSELLORS only. `leads.assigned_to`
  // must always point to a counsellor — sales_managers and super_admins
  // own a TEAM of counsellors, they don't directly carry leads in their
  // queue. Saved rule configs sometimes drift (admin pastes manager UUIDs
  // into target_users, a counsellor gets promoted to manager, etc.); we
  // refuse to honour those entries instead of silently corrupting
  // assigned_to. Same query is the implicit pool when target_users is
  // empty, so both paths produce a valid set of counsellors.
  if (candidates.length) {
    const { rows: validRows } = await tenantQuery(
      tenant,
      `SELECT id FROM users
        WHERE id = ANY($1::uuid[])
          AND role = 'counsellor'
          AND is_active = true
          AND deleted_at IS NULL`,
      [candidates],
    );
    const valid = new Set(validRows.map((u) => u.id));
    // Preserve the rule's intended order (matters for round-robin
    // determinism) while removing the non-counsellor entries.
    const filtered = candidates.filter((id) => valid.has(id));
    candidates.length = 0;
    candidates.push(...filtered);
  }

  // No target team / no valid target_users → fall back to every active
  // counsellor in the tenant. This makes the auto-seeded "Default round-robin"
  // rule work out of the box without admins having to pick users first.
  if (!candidates.length) {
    const { rows: counsellors } = await tenantQuery(
      tenant,
      `SELECT id FROM users
        WHERE role = 'counsellor' AND is_active = true AND deleted_at IS NULL
        ORDER BY created_at`,
    );
    candidates.push(...counsellors.map((u) => u.id));
  }

  // Narrow to the caller-supplied pool (e.g. a manager's own counsellor
  // team). Applied after both the explicit-target and tenant-wide-fallback
  // paths so either source is constrained the same way. An empty intersection
  // means none of this rule's counsellors are in the allowed set — fall
  // through to the rule's fallback (or null) rather than leaking out of the
  // pool.
  if (restrictPool) {
    const allowed = new Set(restrictPool);
    const narrowed = candidates.filter((id) => allowed.has(id));
    candidates.length = 0;
    candidates.push(...narrowed);
  }

  // Empty pool → use the fallback ONLY if it is itself an active counsellor.
  // A fallback pointing at a branch_manager / admin (common: admins paste a
  // manager UUID, or a counsellor gets promoted) must NOT receive leads —
  // leads.assigned_to must always be a counsellor. If the fallback isn't a
  // valid counsellor we return null so the caller leaves the lead UNASSIGNED
  // rather than piling every lead onto one manager (the SpeedUp incident).
  if (!candidates.length) {
    if (!rule.fallback_user_id) return null;
    const { rows: [fb] } = await tenantQuery(
      tenant,
      `SELECT id FROM users
        WHERE id = $1 AND role = 'counsellor' AND is_active = true AND deleted_at IS NULL`,
      [rule.fallback_user_id],
    );
    return fb ? fb.id : null;
  }

  const pool = candidates;

  if (rule.strategy === 'round_robin' || rule.strategy === 'team_round_robin') {
    const { rows: st } = await tenantQuery(tenant, `SELECT last_assigned_user_id FROM assignment_rule_state WHERE rule_id = $1`, [rule.id]);
    const last = st[0]?.last_assigned_user_id;
    const lastIdx = last ? pool.indexOf(last) : -1;
    return pool[(lastIdx + 1) % pool.length];
  }
  if (rule.strategy === 'load_balanced') {
    const { rows: loads } = await tenantQuery(
      tenant,
      `SELECT assigned_to, count(*)::int AS n FROM leads WHERE deleted_at IS NULL AND assigned_to = ANY($1::uuid[]) GROUP BY assigned_to`,
      [pool],
    );
    const map = new Map(loads.map((r) => [r.assigned_to, r.n]));
    return pool.sort((a, b) => (map.get(a) ?? 0) - (map.get(b) ?? 0))[0];
  }
  if (rule.strategy === 'specific_user') return pool[0];
  return pool[0];
};

// Authoritative lead-score recompute. Sums (a) every active lead_score_config
// row whose condition matches the current lead, plus (b) the score column on
// the lead's current stage and sub-stage. Called on lead create AND stage
// change so a stage like "Enrolled" with config rule "stage = enrolled → +N"
// actually bumps the score immediately. lead_score_manual_override wins if
// set so admins can pin a score without losing it on the next event.
export const recalcScore = async (tenant, lead_id) => {
  const { rows: [lead] } = await tenantQuery(tenant, `SELECT * FROM leads WHERE id = $1`, [lead_id]);
  if (!lead) return;
  if (lead.lead_score_manual_override != null) return;
  const { rows: configs } = await tenantQuery(tenant, `SELECT * FROM lead_score_config WHERE is_active AND deleted_at IS NULL`);
  let score = 0;
  for (const c of configs) {
    if (evaluateCondition(c.condition_json, { lead })) score += Number(c.points);
  }
  if (lead.stage_id) {
    const { rows: [s] } = await tenantQuery(tenant, `SELECT score FROM lead_stages WHERE id = $1`, [lead.stage_id]);
    score += Number(s?.score ?? 0);
  }
  if (lead.sub_stage_id) {
    const { rows: [s] } = await tenantQuery(tenant, `SELECT score FROM lead_sub_stages WHERE id = $1`, [lead.sub_stage_id]);
    score += Number(s?.score ?? 0);
  }
  await tenantQuery(tenant, `UPDATE leads SET lead_score = $2 WHERE id = $1`, [lead_id, score]);
};
