import { z } from 'zod';

const leadBaseSchema = z.object({
  // Personal
  name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  alternate_first_name: z.string().optional(),
  email: z.string().email().optional(),
  alternate_email: z.string().email().optional(),
  phone: z.string().min(4).optional(),
  whatsapp_number: z.string().optional(),
  alternate_contact: z.string().optional(),
  gender: z.string().optional(),
  language: z.string().optional(),

  // Education
  ug_degree_id: z.string().uuid().optional(),
  ug_specialization_id: z.string().uuid().optional(),
  ug_university_id: z.string().uuid().optional(),
  ug_graduation_year: z.coerce.number().int().optional(),
  pg_degree_id: z.string().uuid().optional(),
  pg_specialization_id: z.string().uuid().optional(),
  pg_university_id: z.string().uuid().optional(),
  pg_graduation_year: z.coerce.number().int().optional(),

  // Address
  country_id: z.string().uuid().optional(),
  state_id: z.string().uuid().optional(),
  district: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  pincode: z.string().optional(),

  // Program + stage
  program_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  sub_stage_id: z.string().uuid().optional(),
  remarks: z.string().optional(),
  closure_remarks: z.string().optional(),

  // Ownership
  assigned_to: z.string().uuid().optional(),
  team_id: z.string().uuid().optional(),

  // Referral + attribution
  referred_by_lead_id: z.string().uuid().optional(),
  referral_code_used: z.string().optional(),
  referral_source: z.string().optional(),

  // First touch (used for attribution)
  first_touch_campaign_id: z.string().uuid().optional(),
  first_touch_channel: z.string().optional(),
  first_touch_source: z.string().optional(),
  first_touch_medium: z.string().optional(),

  // Family
  family: z.object({
    father_name: z.string().optional(),
    father_mobile: z.string().optional(),
    father_email: z.string().email().optional(),
    mother_name: z.string().optional(),
    mother_mobile: z.string().optional(),
    mother_email: z.string().email().optional(),
    guardian_name: z.string().optional(),
    guardian_mobile: z.string().optional(),
    guardian_email: z.string().email().optional(),
  }).optional(),

  // Custom fields as a dict keyed by field.key
  custom_values: z.record(z.string(), z.any()).optional(),

  // Source attribution (multi)
  sources: z.array(z.object({
    channel_id: z.string().uuid().optional(),
    source_id: z.string().uuid().optional(),
    campaign_id: z.string().uuid().optional(),
    medium_id: z.string().uuid().optional(),
    is_primary: z.boolean().optional(),
  })).optional(),
});

export const leadCreateSchema = leadBaseSchema.refine(
  (v) => v.email || v.phone || v.whatsapp_number || v.name,
  { message: 'At least one of name/email/phone/whatsapp_number is required' },
);

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
  channel_id: z.string().uuid().optional(),
  source_id: z.string().uuid().optional(),
  campaign_id: z.string().uuid().optional(),
  medium_id: z.string().uuid().optional(),
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
