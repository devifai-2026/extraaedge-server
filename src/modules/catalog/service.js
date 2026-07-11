// Course catalog for the student panel + "Enrol" enquiry that raises a lead
// into the existing CRM pipeline (no new payment flow — reuses leads.createLead
// with the sales auto-assignment + dedup already in place).
import { tenantQuery } from '../../db/tenant.js';
import * as leadsService from '../leads/service.js';
import * as leadsRepo from '../leads/repo.js';
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
  const noteBody = `Student portal enquiry for course "${prog[0].name}".`;

  // A current student almost always ALREADY exists as a lead (same email/phone
  // from their original enrolment). Enquiring about another course must NOT
  // create a duplicate lead — attach the enquiry as a note on the existing
  // lead instead. Only create a fresh lead when there's genuinely no match.
  const dups = await leadsRepo.findDuplicates(tenant, { email: s.email, phone: s.phone, whatsapp_number: s.phone });
  if (dups.length) {
    const existing = dups[0];
    try {
      await tenantQuery(tenant, `INSERT INTO lead_notes (lead_id, body, visibility) VALUES ($1, $2, 'internal')`, [existing.id, noteBody]);
      await tenantQuery(tenant, `UPDATE leads SET last_activity_at = now() WHERE id = $1`, [existing.id]);
    } catch { /* note is best-effort */ }
    return { ok: true, lead_id: existing.id, existing: true, course: prog[0].name };
  }

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
  }, { on_duplicate: 'warn' });

  return { ok: true, lead_id: lead?.id ?? null, existing: false, course: prog[0].name };
};
