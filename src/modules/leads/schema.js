import { z } from 'zod';

// Forms in the admin UI submit '' for cleared optional fields. zod's
// `.optional()` only accepts `undefined`, so '' would fail .email() / .uuid()
// even when the field is genuinely blank. These helpers preprocess '' → undefined
// so blank optional fields behave as "no value" rather than "invalid value".
const blankToUndef = (v) => (v === '' || v === null ? undefined : v);
const optionalEmail = z.preprocess(blankToUndef, z.string().email().optional());
const optionalUuid = z.preprocess(blankToUndef, z.string().uuid().optional());
const optionalPhone = z.preprocess(blankToUndef, z.string().min(4).optional());

const leadBaseSchema = z.object({
  // Personal
  name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  alternate_first_name: z.string().optional(),
  email: optionalEmail,
  alternate_email: optionalEmail,
  phone: optionalPhone,
  whatsapp_number: z.string().optional(),
  alternate_contact: z.string().optional(),
  gender: z.string().optional(),
  language: z.string().optional(),

  // Education
  ug_degree_id: optionalUuid,
  ug_specialization_id: optionalUuid,
  ug_university_id: optionalUuid,
  ug_graduation_year: z.coerce.number().int().optional(),
  pg_degree_id: optionalUuid,
  pg_specialization_id: optionalUuid,
  pg_university_id: optionalUuid,
  pg_graduation_year: z.coerce.number().int().optional(),

  // Address
  country_id: optionalUuid,
  state_id: optionalUuid,
  district: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  pincode: z.string().optional(),

  // Program + stage
  program_id: optionalUuid,
  stage_id: optionalUuid,
  sub_stage_id: optionalUuid,
  remarks: z.string().optional(),
  closure_remarks: z.string().optional(),

  // Ownership
  assigned_to: optionalUuid,
  team_id: optionalUuid,

  // Referral + attribution
  referred_by_lead_id: optionalUuid,
  referral_code_used: z.string().optional(),
  referral_source: z.string().optional(),

  // First touch (used for attribution)
  first_touch_campaign_id: optionalUuid,
  first_touch_channel: z.string().optional(),
  first_touch_source: z.string().optional(),
  first_touch_medium: z.string().optional(),

  // Family
  family: z.object({
    father_name: z.string().optional(),
    father_mobile: z.string().optional(),
    father_email: optionalEmail,
    mother_name: z.string().optional(),
    mother_mobile: z.string().optional(),
    mother_email: optionalEmail,
    guardian_name: z.string().optional(),
    guardian_mobile: z.string().optional(),
    guardian_email: optionalEmail,
  }).optional(),

  // Custom fields as a dict keyed by field.key
  custom_values: z.record(z.string(), z.any()).optional(),

  // Source attribution (multi)
  sources: z.array(z.object({
    channel_id: optionalUuid,
    source_id: optionalUuid,
    campaign_id: optionalUuid,
    medium_id: optionalUuid,
    is_primary: z.boolean().optional(),
  })).optional(),

  // Optional audit timestamps. Used during data migration (CSV import or
  // manual backfill) to preserve the original create/update time from the
  // source system. Blank/missing → Postgres defaults apply (now()).
  created_at: z.preprocess(blankToUndef, z.coerce.date().optional()),
  updated_at: z.preprocess(blankToUndef, z.coerce.date().optional()),

  // Follow-up rows to insert alongside the lead. Each row is scoped to a
  // stage: per-stage 5-slot history (status='done', slot_index 1..5) plus
  // optional planned rows. stage_id is required for any slot row; ad-hoc
  // (slot_index null) rows may omit it. sub_stage_id is optional and
  // typically captured via the review modal on save.
  followups: z.array(z.object({
    next_action_datetime: z.coerce.date(),
    comment: z.string().optional().nullable(),
    status: z.enum(['planned', 'done', 'missed', 'cancelled']).optional(),
    stage_id: z.string().uuid().optional(),
    sub_stage_id: z.string().uuid().optional().nullable(),
    slot_index: z.number().int().min(1).max(5).optional().nullable(),
  })).optional(),
});

// Lead creation requires four fields. The base schema marks them all
// optional so that updates can patch a single field; we enforce the
// "required on create" rule here via a chain of refinements that produce
// per-field error paths (so the UI can highlight the right input).
export const leadCreateSchema = leadBaseSchema
  .refine((v) => Boolean((v.name && v.name.trim()) || (v.first_name && v.first_name.trim())), {
    path: ['name'],
    message: 'Name is required',
  })
  .refine((v) => Boolean(v.whatsapp_number && v.whatsapp_number.trim()), {
    path: ['whatsapp_number'],
    message: 'WhatsApp number is required',
  })
  .refine((v) => Boolean(v.program_id), {
    path: ['program_id'],
    message: 'Program is required',
  })
  .refine((v) => Boolean(v.remarks && v.remarks.trim()), {
    path: ['remarks'],
    message: 'Remarks are required',
  });

export const leadUpdateSchema = leadBaseSchema.partial();

export const listQuery = z.object({
  q: z.string().optional(),
  stage_id: z.string().uuid().optional(),
  sub_stage_id: z.string().uuid().optional(),
  program_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  team_id: z.string().uuid().optional(),
  country_id: z.string().uuid().optional(),
  state_id: z.string().uuid().optional(),
  city: z.string().optional(),
  district: z.string().optional(),
  pincode: z.string().optional(),
  channel_id: z.string().uuid().optional(),
  source_id: z.string().uuid().optional(),
  campaign_id: z.string().uuid().optional(),
  medium_id: z.string().uuid().optional(),
  primary_source_id: z.string().uuid().optional(),
  // Personal + education filters (added so the leads list has a filter
  // control for every visible column).
  gender: z.string().optional(),
  language: z.string().optional(),
  ug_degree_id: z.string().uuid().optional(),
  pg_degree_id: z.string().uuid().optional(),
  ug_university_id: z.string().uuid().optional(),
  pg_university_id: z.string().uuid().optional(),
  ug_specialization_id: z.string().uuid().optional(),
  pg_specialization_id: z.string().uuid().optional(),
  ug_graduation_year: z.coerce.number().int().optional(),
  pg_graduation_year: z.coerce.number().int().optional(),
  lead_value: z.string().optional(),
  is_cold: z.preprocess((v) => {
    if (v === 'true' || v === true) return true;
    if (v === 'false' || v === false) return false;
    return undefined;
  }, z.boolean().optional()),
  is_converted: z.preprocess((v) => {
    if (v === 'true' || v === true) return true;
    if (v === 'false' || v === false) return false;
    return undefined;
  }, z.boolean().optional()),
  created_by: z.string().uuid().optional(),
  referral_code_used: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  whatsapp_number: z.string().optional(),
  // Accept 'true' / 'false' strings from query string and coerce explicitly.
  is_touched: z.preprocess((v) => {
    if (v === 'true' || v === true) return true;
    if (v === 'false' || v === false) return false;
    return undefined;
  }, z.boolean().optional()),
  lead_age_from: z.coerce.number().int().min(0).optional(),
  lead_age_to: z.coerce.number().int().min(0).optional(),
  lead_score_from: z.coerce.number().optional(),
  lead_score_to: z.coerce.number().optional(),
  followup_from: z.string().optional(),
  followup_to: z.string().optional(),
  tab: z.string().optional(),
  flag: z.enum(['fresh', 'untouched', 'unassigned']).optional(),
  tag_id: z.string().uuid().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  sort: z.enum(['created_desc', 'created_asc', 'updated_desc', 'score_desc', 'last_activity_desc']).default('created_desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const idParam = z.object({ id: z.string().uuid() });

export const duplicateBehaviorSchema = z.object({
  on_duplicate: z.enum(['block', 'warn', 'create_new']).default('block'),
  force: z.coerce.boolean().default(false),
});

export const stageChangeSchema = z.object({
  stage_id: z.string().uuid(),
  sub_stage_id: z.string().uuid().optional(),
  remarks: z.string().optional(),
  // Optional follow-up scheduling — when present, the service creates a
  // lead_followups row so the lead surfaces in the Follow-up Manager. Used
  // primarily for "Followup" stages but works on any stage transition.
  // Refuse past-dated values so we don't end up with already-overdue rows
  // bypassing the FE validation.
  next_action_datetime: z.coerce.date()
    .refine((d) => d.getTime() > Date.now() - 60_000, {
      message: 'next_action_datetime must be in the future',
    })
    .optional(),
});

export const noteSchema = z.object({
  body: z.string().min(1),
  visibility: z.enum(['internal', 'shared']).default('internal'),
  attachments: z.array(z.string().uuid()).optional(),
});

export const assignSchema = z.object({
  assigned_to: z.string().uuid(),
  reason: z.string().optional(),
  assignment_type: z.enum(['assign', 'reassign', 'auto_assign', 'refer']).default('reassign'),
});

export const referSchema = z.object({
  to_user_id: z.string().uuid(),
  reason: z.string().optional(),
});

export const bulkActionSchema = z.object({
  lead_ids: z.array(z.string().uuid()).min(1).max(5000),
  action: z.enum(['reassign', 'change_stage', 'delete', 'add_tag', 'remove_tag']),
  params: z.record(z.string(), z.any()).default({}),
});

// Bulk delete: requires an explicit list of ids. We intentionally do NOT
// accept a filter object here — bulk delete is destructive and we want the
// caller to commit to a specific selection rather than "delete everything
// matching this filter," which is too easy to misclick.
export const bulkDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'at least one lead id is required'),
});

export const bulkAssignSchema = z.object({
  lead_ids: z.array(z.string().uuid()).optional(),
  filter: z.object({
    q: z.string().optional(),
    stage_id: z.string().uuid().optional(),
    sub_stage_id: z.string().uuid().optional(),
    program_id: z.string().uuid().optional(),
    assigned_to: z.string().uuid().optional(),
    team_id: z.string().uuid().optional(),
  }).optional(),
  assigned_to: z.string().uuid(),
  reason: z.string().optional(),
}).refine((v) => (v.lead_ids && v.lead_ids.length > 0) || v.filter, {
  message: 'Either lead_ids or filter must be provided',
});
