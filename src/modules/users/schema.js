import { z } from 'zod';

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(10),
  role: z.enum(['super_admin', 'sales_manager', 'counsellor']),
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
  role: z.enum(['super_admin', 'sales_manager', 'counsellor']).optional(),
  team_id: z.string().uuid().optional(),
  manager_id: z.string().uuid().optional(),
  is_active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const idParam = z.object({ id: z.string().uuid() });
