import { z } from 'zod';

// `role` is the legacy buckets column on `users` (super_admin / sales_manager
// / counsellor). It still drives a lot of scoping and middleware — see
// SYSTEM_TENANT_ROLES — so it's required on create. `role_id` points at a
// row in `custom_roles` and carries the actual tab/feature permissions; for
// system roles the seeded "Super Admin" / "Sales Manager" / "Counsellor"
// custom_roles rows are used. For genuine custom roles, the `role` column
// must hold the closest matching bucket so existing scope logic
// (auto-assign-unassigned, lead listing, etc.) continues to work.
const roleBucket = z.enum(['super_admin', 'sales_manager', 'counsellor']);

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(10),
  role: roleBucket,
  role_id: z.string().uuid().optional(),
  manager_id: z.string().uuid().optional(),
  // Multi-manager reporting (1:N). First entry is also stored as `manager_id`
  // (primary manager) so legacy lead-scope logic keeps working.
  manager_ids: z.array(z.string().uuid()).optional(),
  team_id: z.string().uuid().optional(),
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
