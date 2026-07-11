import { z } from 'zod';

// `role` is the legacy buckets column on `users` (super_admin / branch_manager
// / sales_manager / counsellor). It still drives a lot of scoping and
// middleware — see SYSTEM_TENANT_ROLES — so it's required on create. `role_id`
// points at a row in `custom_roles` and carries the actual tab/feature
// permissions; for system roles the seeded custom_roles rows are used. For
// genuine custom roles, the `role` column must hold the closest matching
// bucket so existing scope logic (auto-assign-unassigned, lead listing, etc.)
// continues to work. branch_manager scopes its team subtree like sales_manager
// but one tier higher (their branch). account_manager is a tenant-level role
// that reports to its branch_manager (or the tenant super_admin). Creating /
// promoting users into elevated roles is constrained in the service layer.
// Includes the LMS teaching roles (head_trainer / trainer) so trainer users can
// be created from Add-User. `student` is intentionally EXCLUDED — students are a
// separate principal created via Accounts course-confirm, never as a staff user.
const roleBucket = z.enum([
  'super_admin', 'branch_manager', 'sales_manager', 'counsellor', 'account_manager',
  'head_trainer', 'trainer', 'hr', 'placement',
]);

// A phone/whatsapp must be digits only (7–15). Optional/blank is allowed; a
// non-empty value with letters or wrong length is rejected. FE sanitizes to
// digits, but the API is the source of truth.
const phoneField = z.string()
  .optional()
  .nullable()
  .refine((v) => v == null || v === '' || /^\d{7,15}$/.test(v), { message: 'Phone must be 7–15 digits' });

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: phoneField,
  password: z.string().min(10),
  role: roleBucket,
  role_id: z.string().uuid().optional(),
  manager_id: z.string().uuid().optional(),
  // Multi-manager reporting (1:N). First entry is also stored as `manager_id`
  // (primary manager) so legacy lead-scope logic keeps working.
  manager_ids: z.array(z.string().uuid()).optional(),
  team_id: z.string().uuid().optional(),
  // Which branch this user belongs to (multi-branch org). Nullable — the
  // tenant super_admin spans all branches.
  branch_id: z.string().uuid().nullable().optional(),
  // Additional branches a teaching user (trainer/head_trainer) works across —
  // beyond their primary branch_id. Ignored for non-teaching roles.
  branch_ids: z.array(z.string().uuid()).optional(),
  designation: z.string().optional(),
  track_work_time: z.boolean().optional(),
  session_timeout_minutes: z.coerce.number().int().min(5).max(120).optional(),
  permissions_json: z.record(z.string(), z.any()).optional(),
  // Account active flag — used by the User Profiles "Account Status" toggle.
  // On create this almost always stays at the DB default `true`; on update
  // it's the deactivate / reactivate switch.
  is_active: z.boolean().optional(),
});

export const updateUserSchema = createUserSchema.partial().omit({ password: true });

export const changeUserPermissionsSchema = z.object({
  permissions_json: z.record(z.string(), z.any()),
});

export const resetPasswordSchema = z.object({
  new_password: z.string().min(10),
});

export const listUsersQuery = z.object({
  q: z.string().optional(),
  role: roleBucket.optional(),
  team_id: z.string().uuid().optional(),
  manager_id: z.string().uuid().optional(),
  is_active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const idParam = z.object({ id: z.string().uuid() });

// User theme update. All four fields are optional / nullable so the user
// can reset to the system default by sending nulls. Hex format is enforced
// strictly — accepting arbitrary strings would let a malicious user inject
// CSS expressions if these ever leaked into a style attribute on a server-
// rendered surface.
const HEX = /^#[0-9a-fA-F]{6}$/u;
const optionalHex = z
  .union([z.string().regex(HEX, 'Must be a 7-character hex color (e.g. #E53935)'), z.null()])
  .optional();
export const updateThemeSchema = z.object({
  theme_preset: z.union([z.string().max(40), z.null()]).optional(),
  theme_primary: optionalHex,
  theme_primary_dark: optionalHex,
  theme_primary_light: optionalHex,
});

// Avatar update for the currently-logged-in user.
//   avatar_r2_key: GCS object key returned by /uploads/confirm.
//                  Pass null to clear the avatar (initials fallback).
// The key is opaque to us — we don't try to validate it against a regex
// because the uploads/* flow has already verified the object exists.
export const updateAvatarSchema = z.object({
  avatar_r2_key: z.union([z.string().min(1).max(512), z.null()]),
});

// Self-service phone update for the currently-logged-in user (the mandatory
// phone-capture popup on the web calls this). REQUIRED — the whole point is to
// force a number so the mobile app's uploads can be attributed to this user.
export const updateMyPhoneSchema = z.object({
  phone: z.string().min(4).max(20),
});

// OTP-verified phone reset (web profile). Send OTP to a new number, then
// confirm with the received code.
export const sendPhoneOtpSchema = z.object({
  phone: z.string().min(4).max(20),
});
export const verifyPhoneOtpSchema = z.object({
  phone: z.string().min(4).max(20),
  code: z.string().min(4).max(8),
});
