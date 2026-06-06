// Cross-tenant lead inspection for the product_owner. Resolves a tenant from
// the SYSTEM db, then reads that tenant's db (read-only) reusing the existing
// tenant-side lead repo/service so the "full picture" (details + timeline of
// creation / reassigns / followups + bulk-import origin) matches exactly what
// the tenant app shows.
import { resolveTenantById, tenantQuery } from '../../db/tenant.js';
import * as leadsRepo from '../leads/repo.js';
import * as leadsService from '../leads/service.js';
import { notFound, tenantNotFound } from '../../lib/errors.js';

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

// Full lead: scalar + relations (family, sources, assignment history,
// followups) AND the activity timeline (creation, reassigns, followups, etc.).
export const getLeadFull = async (tenantId, leadId) => {
  const tenant = await requireTenant(tenantId);
  const lead = await leadsRepo.findByIdWithRelations(tenant, leadId);
  if (!lead) throw notFound('Lead not found');
  const timeline = await leadsService.getTimeline(tenant, leadId, { limit: 200 });

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

  return { tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name }, lead, timeline, origin };
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
