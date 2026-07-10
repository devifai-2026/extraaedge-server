// Course catalog for the student panel + "Enrol" enquiry that raises a lead
// into the existing CRM pipeline (no new payment flow — reuses leads.createLead
// with the sales auto-assignment + dedup already in place).
import { tenantQuery } from '../../db/tenant.js';
import * as leadsService from '../leads/service.js';
import { notFound } from '../../lib/errors.js';

const studentRow = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, email, phone, program_id FROM students WHERE id = $1 AND deleted_at IS NULL`,
    [studentId],
  );
  return rows[0] || null;
};

// Active courses the student is NOT already enrolled in (their current course
// is excluded — that's "My Course", not something to buy again).
export const catalog = async (tenant, studentId) => {
  const s = await studentRow(tenant, studentId);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, description, category, type, price, currency, discount_price,
            duration_value, duration_unit, image_url, brochure_url
       FROM programs
      WHERE deleted_at IS NULL AND is_active = true
        AND ($1::uuid IS NULL OR id <> $1)
      ORDER BY is_featured DESC, name`,
    [s?.program_id || null],
  );
  return rows;
};

// Raise an enquiry for another course → a new lead (source: student_panel).
// Prefills from the student record; splits their name into first/last.
export const enquire = async (tenant, studentId, programId) => {
  const s = await studentRow(tenant, studentId);
  if (!s) throw notFound('Student not found');
  const { rows: prog } = await tenantQuery(tenant, `SELECT id, name FROM programs WHERE id = $1 AND deleted_at IS NULL`, [programId]);
  if (!prog[0]) throw notFound('Course not found');

  const parts = (s.name || '').trim().split(/\s+/);
  const first_name = parts[0] || s.email;
  const last_name = parts.length > 1 ? parts.slice(1).join(' ') : null;

  // on_duplicate:'warn' → still create the enquiry even if the student already
  // exists as a lead (they're enquiring about a DIFFERENT course); the sales
  // team dedups/merges as usual. force:true bypasses the hard unique backstop
  // by letting createLead surface a friendly result rather than 500.
  const lead = await leadsService.createLead(tenant, null, {
    first_name,
    last_name,
    email: s.email,
    phone: s.phone || null,
    whatsapp_number: s.phone || null,
    program_id: programId,
    first_touch_source: 'student_panel',
    last_touch_source: 'student_panel',
    referral_source: `Student enquiry: ${prog[0].name}`,
  }, { on_duplicate: 'warn', force: true });

  return { ok: true, lead_id: lead?.id ?? null, course: prog[0].name };
};
