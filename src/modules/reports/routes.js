import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { publish } from '../../lib/queue.js';
import { QUEUE_NAMES, SYSTEM_TENANT_ROLES, TEAM_SCOPED_MANAGER_ROLES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';
import ExcelJS from 'exceljs';
import { teamHierarchy } from '../users/repo.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const adminOrManager = requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER);

const idParam = z.object({ id: z.string().uuid() });
const jobIdParam = z.object({ job_id: z.string().uuid() });
const dashSchema = z.object({ date_from: z.coerce.date(), date_to: z.coerce.date(), user_id: z.string().uuid().optional() });

// Lead PDF
router.post('/leads/:id/pdf', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO bulk_exports (user_id, filter_json, status) VALUES ($1, $2::jsonb, 'queued') RETURNING *`,
      [req.user.id, JSON.stringify({ kind: 'lead_pdf', lead_id: req.params.id })],
    );
    await publish(QUEUE_NAMES.PDF, 'lead_pdf', { tenantId: req.tenant.id, job_id: rows[0].id, lead_id: req.params.id });
    res.status(202).json({ data: { job_id: rows[0].id }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Dashboard PDF
router.post('/dashboard/pdf', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: dashSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO bulk_exports (user_id, filter_json, status) VALUES ($1, $2::jsonb, 'queued') RETURNING *`,
      [req.user.id, JSON.stringify({ kind: 'dashboard_pdf', ...req.body })],
    );
    await publish(QUEUE_NAMES.PDF, 'dashboard_pdf', { tenantId: req.tenant.id, job_id: rows[0].id, params: req.body });
    res.status(202).json({ data: { job_id: rows[0].id }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- Lead Transfer Report (admin + sales_manager) ----------
// Every assign/reassign as its own row, with previous owner, current owner,
// the stage the lead was at when transferred, who performed it, and the
// lead's qualification (first time it reached an is_success stage + who owned
// it then). Filterable by date range + acting/owner user. JSON by default;
// `?format=xlsx` streams an Excel file.
const transferQuery = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  // Filter to transfers FROM a user (previous owner) or TO a user (new owner)
  // or performed BY a user. All optional; combine freely.
  from_user_id: z.string().uuid().optional(),
  to_user_id: z.string().uuid().optional(),
  by_user_id: z.string().uuid().optional(),
  assignment_type: z.enum(['assign', 'reassign', 'auto_assign', 'refer', 'unassign']).optional(),
  // Focus the report on a role — e.g. role=counsellor shows only transfers
  // where the previous OR current owner is a counsellor (counsellor perf).
  role: z.enum(['counsellor', 'sales_manager', 'branch_manager', 'super_admin', 'account_manager']).optional(),
  // Filter by the lead's qualification (first time it reached a success
  // stage): who qualified it + the date window it was qualified in.
  qualified_by_user_id: z.string().uuid().optional(),
  qualified_date_from: z.string().optional(),
  qualified_date_to: z.string().optional(),
  format: z.enum(['json', 'xlsx']).optional().default('json'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

const fetchLeadTransfers = async (tenant, q, scopeUserIds) => {
  const params = [];
  const ph = (v) => { params.push(v); return `$${params.length}`; };

  // ---- Transfer-level filters (apply to a lead_assignments row `la`) ----
  // These describe a single transfer. We attach them to the LEFT JOIN's ON
  // clause so only matching transfers become rows. When ANY transfer filter
  // is active we also require a matching transfer to exist (txnFiltered),
  // which drops leads with no matching transfer — otherwise the report is
  // every lead (transferred → one row per transfer, never-transferred → one
  // row with blank transfer columns).
  const joinConds = ['la.lead_id = l.id'];
  let txnFiltered = false;
  const addJoin = (sql, v) => { txnFiltered = true; joinConds.push(sql.replace('$$', ph(v))); };
  if (q.date_from) addJoin('la.created_at >= $$::timestamptz', q.date_from);
  // Inclusive end date: a date-only "to" (e.g. 2026-06-14) should cover the
  // whole day, so we use a half-open upper bound of (to + 1 day).
  if (q.date_to) addJoin("la.created_at < ($$::date + interval '1 day')", q.date_to);
  if (q.from_user_id) addJoin('la.from_user_id = $$', q.from_user_id);
  if (q.to_user_id) addJoin('la.assigned_to = $$', q.to_user_id);
  if (q.by_user_id) addJoin('la.assigned_by = $$', q.by_user_id);
  if (q.assignment_type) addJoin('la.assignment_type = $$', q.assignment_type);

  // ---- Lead-level filters (apply to the outer row) ----
  const conds = ['l.deleted_at IS NULL'];
  const addWhere = (sql, v) => conds.push(sql.replace('$$', ph(v)));
  // When transfer filters are active, keep only leads that have a matching
  // transfer (la.id present); otherwise show every lead.
  if (txnFiltered) conds.push('la.id IS NOT NULL');
  // Role focus: keep rows where the previous OR current owner has this role.
  if (q.role) {
    const p = ph(q.role);
    conds.push(`(EXISTS (SELECT 1 FROM users ur WHERE ur.id = la.from_user_id AND ur.role = ${p})
                 OR EXISTS (SELECT 1 FROM users ur WHERE ur.id = la.assigned_to AND ur.role = ${p}))`);
  }
  // Qualification filters — reference the LATERAL `q` subquery columns.
  if (q.qualified_by_user_id) addWhere('q.qualified_by_user_id = $$', q.qualified_by_user_id);
  if (q.qualified_date_from) addWhere('q.qualified_at >= $$::timestamptz', q.qualified_date_from);
  if (q.qualified_date_to) addWhere("q.qualified_at < ($$::date + interval '1 day')", q.qualified_date_to);
  // Manager scope: only leads whose transfer OR live owner touches their
  // team. Admins (scopeUserIds null) see everything.
  if (scopeUserIds) {
    const p = ph(scopeUserIds);
    conds.push(`(la.from_user_id = ANY(${p}::uuid[]) OR la.assigned_to = ANY(${p}::uuid[])
                 OR la.assigned_by = ANY(${p}::uuid[]) OR l.assigned_to = ANY(${p}::uuid[]))`);
  }

  const joinOn = joinConds.join(' AND ');
  const where = `WHERE ${conds.join(' AND ')}`;
  const offset = (q.page - 1) * q.limit;
  const limitPh = ph(q.limit);
  const offsetPh = ph(offset);

  // One row per matching transfer; leads with no (matching) transfer still
  // appear once via the LEFT JOIN with null transfer columns. ORDER puts
  // the most recent transfers first, then never-transferred leads.
  const baseFrom = `
    FROM leads l
    LEFT JOIN lead_assignments la ON ${joinOn}
    LEFT JOIN users fu     ON fu.id = la.from_user_id
    LEFT JOIN users tu     ON tu.id = la.assigned_to
    LEFT JOIN users bu     ON bu.id = la.assigned_by
    LEFT JOIN lead_stages     s    ON s.id  = la.stage_id_at_transfer
    LEFT JOIN lead_sub_stages ss   ON ss.id = la.sub_stage_id_at_transfer
    LEFT JOIN lead_stages     cur_s ON cur_s.id = l.stage_id
    -- Qualification = first time the lead reached an is_success stage.
    LEFT JOIN LATERAL (
      SELECT au.id AS qualified_by_user_id, au.name AS qualified_by, au.role AS qualified_by_role, a.created_at AS qualified_at
        FROM lead_activities a
        LEFT JOIN lead_stages sgt ON sgt.id = (a.metadata_json->>'to')::uuid
        LEFT JOIN users au ON au.id = a.user_id
       WHERE a.lead_id = l.id
         AND a.type = 'stage_changed'
         AND sgt.is_success = true
       ORDER BY a.created_at ASC
       LIMIT 1
    ) q ON true
    ${where}
  `;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT la.id, l.id AS lead_id, la.assignment_type, la.reason, la.is_active,
              la.created_at AS transferred_at,
              l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email,
              fu.name AS previous_owner, fu.role AS previous_owner_role,
              tu.name AS current_owner,  tu.role AS current_owner_role,
              bu.name AS performed_by,   bu.role AS performed_by_role,
              s.name  AS stage_at_transfer,
              ss.name AS sub_stage_at_transfer,
              cur_s.name AS lead_current_stage,
              q.qualified_by, q.qualified_by_role, q.qualified_at
         ${baseFrom}
         ORDER BY la.created_at DESC NULLS LAST, l.created_at DESC
         LIMIT ${limitPh} OFFSET ${offsetPh}`,
      params,
    ),
    // Distinct leads matched (for the "N leads · M transfers" footer). Uses
    // the same params except the trailing LIMIT/OFFSET, which COUNT ignores.
    tenantQuery(
      tenant,
      `SELECT count(DISTINCT l.id)::int AS leads, count(la.id)::int AS transfers ${baseFrom}`,
      params.slice(0, -2),
    ),
  ]);
  return { rows, leadCount: countRows[0]?.leads ?? 0, transferCount: countRows[0]?.transfers ?? 0 };
};

const TRANSFER_COLUMNS = [
  { header: 'Lead', key: 'lead_name', width: 22 },
  { header: 'Phone', key: 'lead_phone', width: 16 },
  { header: 'Transfer Type', key: 'assignment_type', width: 14 },
  { header: 'Transferred From', key: 'previous_owner', width: 20 },
  { header: 'Transferred To', key: 'current_owner', width: 20 },
  { header: 'Stage at Transfer', key: 'stage_at_transfer', width: 18 },
  { header: 'Sub-Stage at Transfer', key: 'sub_stage_at_transfer', width: 20 },
  { header: 'Performed By', key: 'performed_by', width: 20 },
  { header: 'Qualified By', key: 'qualified_by', width: 20 },
  { header: 'Qualified Date', key: 'qualified_at', width: 20 },
  { header: 'Transferred At', key: 'transferred_at', width: 20 },
  { header: 'Lead Current Stage', key: 'lead_current_stage', width: 18 },
];

router.get('/lead-transfers', adminOrManager, validate({ query: transferQuery }), async (req, res, next) => {
  try {
    // Manager → recursive team scope; admin → all.
    let scopeUserIds = null;
    if (TEAM_SCOPED_MANAGER_ROLES.includes(req.user.role)) {
      scopeUserIds = await teamHierarchy(req.tenant, req.user.id);
    }
    const { rows, leadCount, transferCount } = await fetchLeadTransfers(req.tenant, req.query, scopeUserIds);

    if (req.query.format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Lead Transfers');
      ws.columns = TRANSFER_COLUMNS;
      ws.getRow(1).font = { bold: true };
      for (const r of rows) {
        ws.addRow({
          ...r,
          transferred_at: r.transferred_at ? new Date(r.transferred_at).toLocaleString('en-IN') : '',
          qualified_at: r.qualified_at ? new Date(r.qualified_at).toLocaleString('en-IN') : '',
        });
      }
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="lead-transfers-${req.tenant.slug}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    }

    return res.json({
      data: rows,
      meta: { requestId: req.id, count: rows.length, lead_count: leadCount, transfer_count: transferCount, page: req.query.page, limit: req.query.limit },
    });
  } catch (err) { next(err); }
});

router.get('/:job_id', validate({ params: jobIdParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM bulk_exports WHERE id = $1`, [req.params.job_id]);
    if (!rows[0]) throw notFound('Report not found');
    const data = { ...rows[0] };
    if (rows[0].status === 'completed' && rows[0].file_r2_key) {
      data.signed_url = await getDownloadSignedUrl({ key: rows[0].file_r2_key, downloadAs: `report-${req.params.job_id}.pdf` });
    }
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
