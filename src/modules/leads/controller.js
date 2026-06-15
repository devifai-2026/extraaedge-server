import * as service from './service.js';
import { rowsToCsv } from '../../lib/csv.js';

export const list = async (req, res, next) => {
  try {
    const { rows, total } = await service.listLeads(req.tenant, req.user, req.query);
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit, total } });
  } catch (err) { next(err); }
};

// CSV column order + friendly headers. `key` matches the SELECT alias in
// repo.exportList; `header` is what lands in the CSV's first row.
const EXPORT_COLUMNS = [
  { key: 'name', header: 'Name' },
  { key: 'email', header: 'Email' },
  { key: 'phone', header: 'Phone' },
  { key: 'whatsapp_number', header: 'WhatsApp' },
  { key: 'alternate_contact', header: 'Alternate Contact' },
  { key: 'gender', header: 'Gender' },
  { key: 'language', header: 'Language' },
  { key: 'stage_name', header: 'Stage' },
  { key: 'sub_stage_name', header: 'Sub Stage' },
  { key: 'program_name', header: 'Program' },
  { key: 'country_name', header: 'Country' },
  { key: 'state_name', header: 'State' },
  { key: 'district', header: 'District' },
  { key: 'city', header: 'City' },
  { key: 'pincode', header: 'Pincode' },
  { key: 'primary_source_name', header: 'Source' },
  { key: 'assigned_to_name', header: 'Owner' },
  { key: 'manager_name', header: 'Manager' },
  { key: 'created_by_name', header: 'Added By' },
  { key: 'lead_score', header: 'Lead Score' },
  { key: 'engagement_score', header: 'Engagement Score' },
  { key: 'lead_value', header: 'Lead Value' },
  { key: 'is_cold', header: 'Cold' },
  { key: 'is_converted', header: 'Converted' },
  { key: 'converted_at', header: 'Converted At' },
  { key: 'lead_age_days', header: 'Age (days)' },
  { key: 'created_at', header: 'Created At' },
  { key: 'updated_at', header: 'Updated At' },
  { key: 'last_activity_at', header: 'Last Activity At' },
];

const toCsvValue = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v;
};

// GET /leads/export.csv — streams the WHOLE filtered lead list (no pagination)
// as a CSV download. Super-admin only (enforced at the route layer). Honors
// the same query-string filters as GET /leads so the export matches the
// on-screen list. A UTF-8 BOM is prepended so Excel renders non-ASCII names.
export const exportCsv = async (req, res, next) => {
  try {
    const rows = await service.exportLeads(req.tenant, req.user, req.query);
    const records = rows.map((row) => {
      const out = {};
      for (const col of EXPORT_COLUMNS) out[col.header] = toCsvValue(row[col.key]);
      return out;
    });
    const csv = await rowsToCsv(records, EXPORT_COLUMNS.map((c) => c.header));
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `leads-${req.tenant?.slug ?? 'export'}-${stamp}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(`﻿${csv}`);
  } catch (err) { next(err); }
};

export const stageCounts = async (req, res, next) => {
  try {
    const data = await service.stageCounts(req.tenant, req.user, req.query);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const autoAssignUnassigned = async (req, res, next) => {
  try {
    const data = await service.autoAssignUnassigned(req.tenant);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const bulkAssign = async (req, res, next) => {
  try {
    const result = await service.bulkAssign(req.tenant, req.user, req.body);
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const get = async (req, res, next) => {
  try { res.json({ data: await service.getLead(req.tenant, req.user, req.params.id), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
};

export const create = async (req, res, next) => {
  try {
    const { on_duplicate, force, ...rest } = req.body;
    const lead = await service.createLead(req.tenant, req.user, rest, { on_duplicate, force });
    res.status(201).json({ data: lead, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const lead = await service.updateLead(req.tenant, req.user, req.params.id, req.body);
    res.json({ data: lead, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const remove = async (req, res, next) => {
  try { await service.deleteLead(req.tenant, req.user, req.params.id); res.status(204).end(); }
  catch (err) { next(err); }
};

// POST /leads/bulk-delete { ids: [uuid,...] }
// Hard-deletes every lead in `ids`. FK CASCADEs wipe follow-ups, notes,
// assignments, activities, family, source attributions, custom values, tags,
// calls, recordings, payments and referral edges — nothing about the lead
// survives in the tenant DB. Super-admin only (enforced at route layer).
export const bulkDelete = async (req, res, next) => {
  try {
    const result = await service.bulkDeleteLeads(req.tenant, req.user, req.body?.ids ?? []);
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const changeStage = async (req, res, next) => {
  try {
    const lead = await service.changeStage(req.tenant, req.user, req.params.id, req.body);
    res.json({ data: lead, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

export const timeline = async (req, res, next) => {
  try {
    const rows = await service.getTimeline(req.tenant, req.params.id, {
      limit: req.query.limit ?? 100,
      before: req.query.before,
    });
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};
