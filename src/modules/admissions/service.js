import * as repo from './repo.js';
import { notFound } from '../../lib/errors.js';
import { tenantQuery } from '../../db/tenant.js';
import { notifyUser } from '../../lib/socket.js';
import { pushNotification } from '../notifications/service.js';
import { logger } from '../../lib/logger.js';

export const listCenters = (tenant) => repo.listCenters(tenant);
export const createCenter = (tenant, input) => repo.insertCenter(tenant, input);
export const updateCenter = async (tenant, id, patch) => {
  const updated = await repo.updateCenter(tenant, id, patch);
  if (!updated) throw notFound('Center not found');
  return updated;
};
export const deleteCenter = (tenant, id) => repo.softDeleteCenter(tenant, id);

export const list = (tenant, q) => repo.list(tenant, q);
export const get = async (tenant, id) => {
  const row = await repo.findByIdWithRelations(tenant, id);
  if (!row) throw notFound('Admission not found');
  return row;
};

export const create = (tenant, actor, input) =>
  repo.insert(tenant, input, actor?.id);

export const update = async (tenant, id, patch) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Admission not found');
  return repo.updateRow(tenant, id, patch);
};

export const remove = async (tenant, id) => {
  const existing = await repo.findById(tenant, id);
  if (!existing) throw notFound('Admission not found');
  await repo.softDelete(tenant, id);
};

export const approve = async (tenant, actor, id) => {
  const row = await repo.approve(tenant, id, actor?.id);
  if (!row) throw notFound('Admission not found or already approved');
  return row;
};

export const setStatus = async (tenant, id, status, extra) => {
  const row = await repo.setStatus(tenant, id, status, extra);
  if (!row) throw notFound('Admission not found');
  return row;
};

export const listReceipts = (tenant, q) => repo.listReceipts(tenant, q);

export const createReceipt = async (tenant, actor, admission_id, input) => {
  const adm = await repo.findById(tenant, admission_id);
  if (!adm) throw notFound('Admission not found');
  return repo.insertReceipt(tenant, admission_id, input, actor?.id);
};

export const deleteReceipt = (tenant, id) => repo.deleteReceipt(tenant, id);

export const paySchedule = (tenant, q) => repo.paySchedule(tenant, q);
export const collectionReceiptWise = (tenant, q) => repo.collectionReceiptWise(tenant, q);
export const dashboard = (tenant) => repo.dashboard(tenant);

export const pendingAdmissions = (tenant) => repo.pendingAdmissions(tenant);
export const pendingAdmissionsCount = (tenant) => repo.pendingAdmissionsCount(tenant);

// Compound dashboard fetch: KPI cards (existing) + 4 chart datasets.
// One round-trip from the FE; ~5 queries server-side run in parallel.
export const dashboardWithCharts = async (tenant, { trend_days = 30 } = {}) => {
  const [kpis, admTrend, colTrend, breakdown, courses] = await Promise.all([
    repo.dashboard(tenant),
    repo.admissionsTrend(tenant, trend_days),
    repo.collectionTrend(tenant, trend_days),
    repo.statusBreakdown(tenant),
    repo.courseBreakdown(tenant),
  ]);
  return {
    ...kpis,
    charts: {
      admissions_trend: admTrend,
      collection_trend: colTrend,
      status_breakdown: breakdown,
      course_breakdown: courses,
      trend_days,
    },
  };
};

// Resolve every active account_manager (+ super_admin) user in the tenant
// so we can fan out a "new pending admission" notification.
const findAccountsAudience = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM users
      WHERE deleted_at IS NULL
        AND is_active = true
        AND role IN ('account_manager', 'super_admin')`,
  );
  return rows.map((r) => r.id);
};

// Fire both a persistent DB notification + a live socket event for every
// account_manager / super_admin. Best-effort; failures don't block the
// admission insert.
const notifyPendingAdmission = async (tenant, admission, lead) => {
  try {
    const recipients = await findAccountsAudience(tenant);
    const name = lead?.name
      || [admission?.first_name, admission?.last_name].filter(Boolean).join(' ')
      || 'New lead';
    const payload = {
      admission_id: admission?.id || null,
      lead_id: lead?.id || null,
      student_name: name,
      program_id: admission?.program_id || lead?.program_id || null,
    };
    for (const uid of recipients) {
      try {
        await pushNotification(tenant, {
          user_id: uid,
          type: 'admission.pending',
          message: `${name} is ready for admission`,
          metadata_json: payload,
          link: `/accounts/pending-admissions`,
        });
        notifyUser(tenant.id, uid, 'admission.pending', payload);
      } catch (err) {
        logger.warn({ err: err.message, user_id: uid }, 'notify pending-admission failed');
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'pending-admission audience lookup failed');
  }
};

// Auto-create stub admission when a lead transitions into an is_success
// stage. Called from leads/service.changeStage. Idempotent — if an
// admission already exists for the lead, returns the existing one.
export const ensureFromConvertedLead = async (tenant, lead) => {
  if (!lead?.id) return null;
  const { rows: existing } = await tenantQuery(
    tenant,
    `SELECT id FROM admissions WHERE lead_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [lead.id],
  );
  if (existing[0]) return existing[0];
  // Split a single "name" into first/last for the admission row. If the
  // lead already has first/last we use those; otherwise fall back to a
  // naive split on the first space.
  let first = lead.first_name || '';
  let last  = lead.last_name || '';
  if (!first && lead.name) {
    const parts = String(lead.name).trim().split(/\s+/);
    first = parts[0] || lead.name;
    last  = parts.slice(1).join(' ') || '';
  }
  // We deliberately leave whatsapp_number nullable on the DB but the
  // schema requires it; admissions module schema accepts the seeded
  // row even if blank because we bypass zod here. The form will fill
  // in the rest before approval anyway.
  const admission = await repo.insert(tenant, {
    lead_id: lead.id,
    admission_date: new Date(),
    first_name: first || 'Unnamed',
    last_name: last || null,
    email: lead.email || null,
    whatsapp_number: lead.whatsapp_number || lead.phone || '',
    program_id: lead.program_id || null,
    mode_of_training: 'Offline',
    total_fees: 0,
    status: 'pending_approval',
    guided_by_counsellor_id: lead.assigned_to || null,
    source: lead.first_touch_source || null,
  }, lead.created_by);
  // Notify the accounts team (best-effort).
  notifyPendingAdmission(tenant, admission, lead).catch(() => {});
  return admission;
};
