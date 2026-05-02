import { registerWorker, publish } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { evaluateCondition, materializeActions } from '../services/rule-engine.js';
import { logger } from '../lib/logger.js';

registerWorker(QUEUE_NAMES.WORKFLOW, async ({ data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;

  const logEvent = async (node_id, event_type, payload) => {
    await tenantQuery(
      tenant,
      `INSERT INTO workflow_run_events (run_id, node_id, event_type, payload_json) VALUES ($1,$2,$3,$4::jsonb)`,
      [data.run_id, node_id ?? null, event_type, JSON.stringify(payload ?? {})],
    );
  };

  try {
    const { rows: [run] } = await tenantQuery(tenant, `SELECT * FROM workflow_runs WHERE id = $1`, [data.run_id]);
    const { rows: nodes } = await tenantQuery(tenant, `SELECT * FROM workflow_nodes WHERE workflow_id = $1 ORDER BY order_index`, [data.workflow_id]);
    const { rows: edges } = await tenantQuery(tenant, `SELECT * FROM workflow_edges WHERE workflow_id = $1`, [data.workflow_id]);
    const { rows: [lead] } = data.lead_id ? await tenantQuery(tenant, `SELECT * FROM leads WHERE id = $1`, [data.lead_id]) : { rows: [null] };

    const outgoing = new Map();
    for (const e of edges) {
      const list = outgoing.get(e.from_node_id) ?? [];
      list.push(e);
      outgoing.set(e.from_node_id, list);
    }

    // Start at the first `trigger` node.
    let current = nodes.find((n) => n.type === 'trigger') ?? nodes[0];
    if (!current) {
      await tenantQuery(tenant, `UPDATE workflow_runs SET status = 'failed', error = 'no start node', ended_at = now() WHERE id = $1`, [data.run_id]);
      return;
    }

    const ctx = { lead, run: run?.context_json ?? {} };

    while (current) {
      await logEvent(current.id, `node_entered:${current.type}`, { config: current.config_json });
      if (current.type === 'condition') {
        const match = evaluateCondition(current.config_json?.condition, ctx);
        const next = (outgoing.get(current.id) ?? []).find((e) => String(e.label).toLowerCase() === (match ? 'true' : 'false'));
        current = next ? nodes.find((n) => n.id === next.to_node_id) : null;
        continue;
      }
      if (current.type === 'wait') {
        const delayMs = Number(current.config_json?.delay_ms ?? 0);
        if (delayMs > 0 && !data.dry_run) {
          // Re-enqueue with delay to resume from the next node.
          const next = (outgoing.get(current.id) ?? [])[0];
          if (next) {
            await publish(QUEUE_NAMES.WORKFLOW, 'resume', { tenantId: tenant.id, workflow_id: data.workflow_id, run_id: data.run_id, lead_id: data.lead_id, resume_node_id: next.to_node_id }, { delay: delayMs });
          }
          return;
        }
        current = nodes.find((n) => n.id === (outgoing.get(current.id) ?? [])[0]?.to_node_id);
        continue;
      }
      if (current.type === 'action') {
        const actions = materializeActions(current.config_json?.actions ?? [current.config_json], ctx);
        for (const action of actions) {
          if (data.dry_run) {
            await logEvent(current.id, 'action_dry_run', action);
            continue;
          }
          switch (action.type) {
            case 'assign': {
              if (lead && action.user_id) {
                // Snap manager_id from the new owner so leadlist + LeadCard
                // hierarchy stay coherent. Also drop a timeline row so the
                // workflow's effect is auditable. Mirrors rule-processor.js.
                const { rows: mgrRows } = await tenantQuery(
                  tenant,
                  `SELECT manager_id FROM users WHERE id = $1`,
                  [action.user_id],
                );
                const newManagerId = mgrRows[0]?.manager_id ?? null;
                await tenantQuery(
                  tenant,
                  `UPDATE leads SET assigned_to = $2, manager_id = $3, last_activity_at = now() WHERE id = $1`,
                  [lead.id, action.user_id, newManagerId],
                );
                await tenantQuery(
                  tenant,
                  `INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, assignment_type, is_active, status) VALUES ($1,$2,NULL,'auto_assign',true,'open')`,
                  [lead.id, action.user_id],
                );
                await tenantQuery(
                  tenant,
                  `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
                   VALUES ($1, NULL, 'auto_assign', 'Assigned by workflow', $2::jsonb)`,
                  [lead.id, JSON.stringify({ assigned_to: action.user_id, workflow_run_id: data.run_id })],
                );
              }
              break;
            }
            case 'send_message': {
              if (lead && action.channel && action.template_id) {
                const recipField = action.channel === 'email' ? 'email' : action.channel === 'whatsapp' ? 'whatsapp_number' : 'phone';
                const recipient = lead[recipField] ?? lead.phone;
                if (recipient) {
                  const { rows: [log] } = await tenantQuery(
                    tenant,
                    `INSERT INTO message_log (lead_id, channel, template_id, recipient, provider, status, workflow_run_id)
                     VALUES ($1,$2,$3,$4,$5,'queued',$6) RETURNING id`,
                    [lead.id, action.channel, action.template_id, recipient, action.channel === 'email' ? 'brevo' : action.channel === 'sms' ? 'messagecentral' : 'wabridge', data.run_id],
                  );
                  const qname = action.channel === 'email' ? QUEUE_NAMES.EMAIL : action.channel === 'sms' ? QUEUE_NAMES.SMS : QUEUE_NAMES.WHATSAPP;
                  await publish(qname, 'send', { tenantId: tenant.id, message_log_id: log.id, lead_id: lead.id, template_id: action.template_id });
                }
              }
              break;
            }
            case 'schedule_follow_up': {
              if (lead && action.offset_hours) {
                const when = new Date(Date.now() + Number(action.offset_hours) * 3600_000);
                await tenantQuery(
                  tenant,
                  `INSERT INTO lead_followups (lead_id, next_action_datetime, comment, status) VALUES ($1,$2,$3,'planned')`,
                  [lead.id, when, action.comment ?? 'Workflow-scheduled follow-up'],
                );
              }
              break;
            }
            case 'add_score': {
              if (lead && action.points) {
                await tenantQuery(tenant, `UPDATE leads SET lead_score = lead_score + $2 WHERE id = $1`, [lead.id, Number(action.points)]);
              }
              break;
            }
            case 'set_field': {
              if (lead && action.field) {
                await tenantQuery(tenant, `UPDATE leads SET ${action.field} = $2 WHERE id = $1`, [lead.id, action.value]);
              }
              break;
            }
            case 'add_tag': {
              if (lead && action.tag_id) {
                await tenantQuery(tenant, `INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [lead.id, action.tag_id]);
              }
              break;
            }
            default: await logEvent(current.id, 'unknown_action', action);
          }
        }
      }
      const nextEdge = (outgoing.get(current.id) ?? [])[0];
      current = nextEdge ? nodes.find((n) => n.id === nextEdge.to_node_id) : null;
    }

    await tenantQuery(tenant, `UPDATE workflow_runs SET status = 'succeeded', ended_at = now() WHERE id = $1`, [data.run_id]);
  } catch (err) {
    logger.error({ err: err.message, run_id: data.run_id }, 'workflow-executor failed');
    await tenantQuery(tenant, `UPDATE workflow_runs SET status = 'failed', error = $2, ended_at = now() WHERE id = $1`, [data.run_id, err.message]).catch(() => {});
  }
}, { concurrency: 2, jobName: '*' });
