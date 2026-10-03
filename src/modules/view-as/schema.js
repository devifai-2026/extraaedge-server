import { z } from 'zod';

export const startViewAsSchema = z.object({
  // Who to look at. Must be inside the branch manager's own branch subtree —
  // enforced in the service, not here.
  target_user_id: z.string().uuid(),
  // Required, and recorded on the session row. A branch manager stepping into
  // a staff member's screens is a supervisory act; it is logged with a stated
  // purpose or it does not happen.
  reason: z.string().min(5).max(500),
});

export const listQuery = z.object({
  target_user_id: z.string().uuid().optional(),
  active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
