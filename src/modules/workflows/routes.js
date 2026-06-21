import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES, QUEUE_NAMES, EVENT_TYPES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';
import { publish } from '../../lib/queue.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const idParam = z.object({ id: z.string().uuid() });
const runIdParam = z.object({ run_id: z.string().uuid() });

const nodeSchema = z.object({
  id: z.string().optional(),
  type: z.enum(['trigger', 'action', 'condition', 'wait']),
  config_json: z.record(z.string(), z.any()),
  position_x: z.number().int().optional(),
  position_y: z.number().int().optional(),
});

const edgeSchema = z.object({ from_node_id: z.string(), to_node_id: z.string(), label: z.string().optional() });

const workflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category_id: z.string().uuid().optional(),
  trigger_event_types: z.array(z.string()).optional(),
  is_active: z.boolean().default(false),
  start_time: z.coerce.date().optional(),
  nodes: z.array(nodeSchema).optional(),
  edges: z.array(edgeSchema).optional(),
});

// Categories
router.get('/categories', async (req, res, next) => {
  try { const { rows } = await tenantQuery(req.tenant, `SELECT * FROM workflow_categories WHERE deleted_at IS NULL ORDER BY name`); res.json({ data: rows, meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.post('/categories', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ body: z.object({ name: z.string().min(1), description: z.string().optional(), icon: z.string().optional() }) }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `INSERT INTO workflow_categories (name, description, icon) VALUES ($1,$2,$3) RETURNING *`, [req.body.name, req.body.description ?? null, req.body.icon ?? null]);
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/categories/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam, body: z.object({ name: z.string().optional(), description: z.string().optional(), icon: z.string().optional() }) }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) { if (v === undefined) continue; fields.push(`${k} = $${i}`); params.push(v); i += 1; }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE workflow_categories SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Workflows
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT w.*, c.name AS category_name FROM workflows w LEFT JOIN workflow_categories c ON c.id = w.category_id
        WHERE w.deleted_at IS NULL ORDER BY w.name`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows: [wf] } = await tenantQuery(req.tenant, `SELECT * FROM workflows WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!wf) throw notFound('Workflow not found');
    const [nodes, edges] = await Promise.all([
      tenantQuery(req.tenant, `SELECT * FROM workflow_nodes WHERE workflow_id = $1 ORDER BY order_index`, [req.params.id]),
      tenantQuery(req.tenant, `SELECT * FROM workflow_edges WHERE workflow_id = $1`, [req.params.id]),
    ]);
    res.json({ data: { ...wf, nodes: nodes.rows, edges: edges.rows }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: workflowSchema }), async (req, res, next) => {
  try {
    const result = await tenantTx(req.tenant, async (client) => {
      const { rows: [wf] } = await client.query(
        `INSERT INTO workflows (name, description, category_id, trigger_event_types, is_active, start_time, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.body.name, req.body.description ?? null, req.body.category_id ?? null, req.body.trigger_event_types ?? null, req.body.is_active, req.body.start_time ?? null, req.user.id],
      );
      const nodeIdMap = new Map();
      for (const [idx, n] of (req.body.nodes ?? []).entries()) {
        const { rows: [row] } = await client.query(
          `INSERT INTO workflow_nodes (workflow_id, type, config_json, position_x, position_y, order_index) VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING id`,
          [wf.id, n.type, JSON.stringify(n.config_json), n.position_x ?? null, n.position_y ?? null, idx],
        );
        if (n.id) nodeIdMap.set(n.id, row.id);
      }
      for (const e of req.body.edges ?? []) {
        const fromId = nodeIdMap.get(e.from_node_id) ?? e.from_node_id;
        const toId = nodeIdMap.get(e.to_node_id) ?? e.to_node_id;
        await client.query(
          `INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, label) VALUES ($1,$2,$3,$4)`,
          [wf.id, fromId, toId, e.label ?? null],
        );
      }
      return wf;
    });
    res.status(201).json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: workflowSchema.partial() }), async (req, res, next) => {
  try {
    const result = await tenantTx(req.tenant, async (client) => {
      const fields = []; const params = []; let i = 1;
      for (const [k, v] of Object.entries(req.body)) {
        if (v === undefined || ['nodes', 'edges'].includes(k)) continue;
        fields.push(`${k} = $${i}`); params.push(v); i += 1;
      }
      if (fields.length) {
        params.push(req.params.id);
        await client.query(`UPDATE workflows SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL`, params);
      }
      if (req.body.nodes || req.body.edges) {
        // Replace nodes + edges wholesale — simplest correct semantic for visual builder.
        await client.query(`DELETE FROM workflow_edges WHERE workflow_id = $1`, [req.params.id]);
        await client.query(`DELETE FROM workflow_nodes WHERE workflow_id = $1`, [req.params.id]);
        const idMap = new Map();
        for (const [idx, n] of (req.body.nodes ?? []).entries()) {
          const { rows: [row] } = await client.query(
            `INSERT INTO workflow_nodes (workflow_id, type, config_json, position_x, position_y, order_index) VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING id`,
            [req.params.id, n.type, JSON.stringify(n.config_json), n.position_x ?? null, n.position_y ?? null, idx],
          );
          if (n.id) idMap.set(n.id, row.id);
        }
        for (const e of req.body.edges ?? []) {
          await client.query(
            `INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, label) VALUES ($1,$2,$3,$4)`,
            [req.params.id, idMap.get(e.from_node_id) ?? e.from_node_id, idMap.get(e.to_node_id) ?? e.to_node_id, e.label ?? null],
          );
        }
      }
      const { rows } = await client.query(`SELECT * FROM workflows WHERE id = $1`, [req.params.id]);
      return rows[0];
    });
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE workflows SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

router.post('/:id/toggle', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `UPDATE workflows SET is_active = NOT is_active WHERE id = $1 AND deleted_at IS NULL RETURNING *`, [req.params.id]);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Trigger + test
router.post('/:id/execute', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: z.object({ lead_id: z.string().uuid().optional() }) }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO workflow_runs (workflow_id, lead_id, status, started_at) VALUES ($1,$2,'running', now()) RETURNING *`,
      [req.params.id, req.body.lead_id ?? null],
    );
    await publish(QUEUE_NAMES.WORKFLOW, 'run', { tenantId: req.tenant.id, workflow_id: req.params.id, run_id: rows[0].id, lead_id: req.body.lead_id ?? null });
    res.status(202).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/test', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: z.object({ lead_id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    // Dry-run — workflow_runs row marked as test; worker supports dry_run flag.
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO workflow_runs (workflow_id, lead_id, status, started_at, context_json)
       VALUES ($1,$2,'running',now(),'{"dry_run":true}'::jsonb) RETURNING *`,
      [req.params.id, req.body.lead_id],
    );
    await publish(QUEUE_NAMES.WORKFLOW, 'run', { tenantId: req.tenant.id, workflow_id: req.params.id, run_id: rows[0].id, lead_id: req.body.lead_id, dry_run: true });
    res.status(202).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id/runs', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 200`,
      [req.params.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/runs/:run_id', validate({ params: runIdParam }), async (req, res, next) => {
  try {
    const [{ rows: runRows }, { rows: events }] = await Promise.all([
      tenantQuery(req.tenant, `SELECT * FROM workflow_runs WHERE id = $1`, [req.params.run_id]),
      tenantQuery(req.tenant, `SELECT * FROM workflow_run_events WHERE run_id = $1 ORDER BY occurred_at`, [req.params.run_id]),
    ]);
    if (!runRows[0]) throw notFound('Run not found');
    res.json({ data: { ...runRows[0], events }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
