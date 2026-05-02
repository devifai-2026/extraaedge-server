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
    // Lead-centric events trigger assignment + score updates
    if (data.type === EVENT_TYPES.LEAD_CREATED && data.payload?.lead) {
      await applyAssignment(tenant, data.payload.lead);
      await recalcScore(tenant, data.payload.lead.id);
    }

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
          if (a.type === 'send_message' && lead && a.channel && a.template_id) {
            const { rows: [log] } = await tenantQuery(
              tenant,
              `INSERT INTO message_log (lead_id, channel, template_id, recipient, provider, status)
               VALUES ($1,$2,$3,$4,$5,'queued') RETURNING id`,
              [lead.id, a.channel, a.template_id, lead[a.channel === 'email' ? 'email' : a.channel === 'whatsapp' ? 'whatsapp_number' : 'phone'], a.channel === 'email' ? 'brevo' : a.channel === 'sms' ? 'messagecentral' : 'wabridge'],
            );
            const qname = a.channel === 'email' ? QUEUE_NAMES.EMAIL : a.channel === 'sms' ? QUEUE_NAMES.SMS : QUEUE_NAMES.WHATSAPP;
            await publish(qname, 'send', { tenantId: tenant.id, message_log_id: log.id, lead_id: lead.id, template_id: a.template_id });
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'rule-processor failed');
  }
}, { concurrency: 4, jobName: '*' });

// Assignment-rules engine — picks the first matching rule and applies its strategy.
const applyAssignment = async (tenant, lead) => {
  const { rows: rules } = await tenantQuery(tenant, `SELECT * FROM assignment_rules WHERE is_active AND deleted_at IS NULL ORDER BY priority`);
  for (const rule of rules) {
    if (!evaluateCondition(rule.condition_json, { lead })) continue;
    const targetUser = await pickTarget(tenant, rule);
    if (!targetUser) continue;
    await tenantQuery(tenant, `UPDATE leads SET assigned_to = $2, last_activity_at = now() WHERE id = $1`, [lead.id, targetUser]);
    await tenantQuery(tenant, `INSERT INTO lead_assignments (lead_id, assigned_to, assignment_type, is_active, status) VALUES ($1,$2,'auto_assign',true,'open')`, [lead.id, targetUser]);
    await tenantQuery(tenant, `UPDATE assignment_rule_state SET last_assigned_user_id = $2, last_assigned_at = now(), total_assignments = total_assignments + 1 WHERE rule_id = $1`, [rule.id, targetUser]);
    await publish(QUEUE_NAMES.EVENTS, EVENT_TYPES.LEAD_ASSIGNED, {
      type: EVENT_TYPES.LEAD_ASSIGNED,
      tenantId: tenant.id,
      occurredAt: new Date().toISOString(),
      entityType: 'lead',
      entityId: lead.id,
      payload: { assigned_to: targetUser, rule_id: rule.id },
    });
    return;
  }
};

const pickTarget = async (tenant, rule) => {
  const candidates = [];
  if (rule.target_team_id) {
    const { rows } = await tenantQuery(tenant, `SELECT user_id FROM team_members WHERE team_id = $1`, [rule.target_team_id]);
    candidates.push(...rows.map((r) => r.user_id));
  }
  if (rule.target_users) candidates.push(...rule.target_users);
  if (!candidates.length) return rule.fallback_user_id;

  // Skip unavailable users
  let pool = candidates;
  if (rule.skip_unavailable) {
    const { rows: unav } = await tenantQuery(
      tenant,
      `SELECT DISTINCT user_id FROM user_availability WHERE deleted_at IS NULL AND now() BETWEEN starts_at AND ends_at`,
    );
    const unset = new Set(unav.map((u) => u.user_id));
    pool = candidates.filter((id) => !unset.has(id));
  }
  if (!pool.length) return rule.fallback_user_id;

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

const recalcScore = async (tenant, lead_id) => {
  const { rows: [lead] } = await tenantQuery(tenant, `SELECT * FROM leads WHERE id = $1`, [lead_id]);
  if (!lead) return;
  const { rows: configs } = await tenantQuery(tenant, `SELECT * FROM lead_score_config WHERE is_active AND deleted_at IS NULL`);
  let score = 0;
  for (const c of configs) {
    if (evaluateCondition(c.condition_json, { lead })) score += Number(c.points);
  }
  await tenantQuery(tenant, `UPDATE leads SET lead_score = $2 WHERE id = $1`, [lead_id, score]);
};
