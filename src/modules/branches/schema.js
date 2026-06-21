import { z } from 'zod';

export const idParam = z.object({ id: z.string().uuid() });

export const createBranchSchema = z.object({
  name: z.string().min(1).max(120),
  code: z.string().max(20).optional(),
  branch_manager_id: z.string().uuid().optional(),
  is_active: z.boolean().optional(),
});

export const updateBranchSchema = createBranchSchema.partial();

// Assign a user to this branch (or clear with branch_id null at the service).
export const assignUserSchema = z.object({
  user_id: z.string().uuid(),
});
