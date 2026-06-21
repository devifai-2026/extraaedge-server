import { z } from 'zod';
import { DISCOUNT } from '../../config/constants.js';

export const leadIdParam = z.object({ leadId: z.string().uuid() });

// Apply / request a discount. Counsellors are capped at COUNSELLOR_MAX_PERCENT
// (enforced in the service via the approval flow, not here — the FE still
// allows higher values which then route to approval).
export const applyDiscountSchema = z.object({
  discount_percent: z.coerce.number().min(0).max(DISCOUNT.MAX_PERCENT),
  reason: z.string().max(500).optional(),
});

// Manager decision on a pending discount. `final_percent` (approve only) lets
// the manager grant a different % than the counsellor requested.
export const decideDiscountSchema = z.object({
  decision: z.enum([DISCOUNT.STATUS.APPROVED, DISCOUNT.STATUS.REJECTED]),
  reject_reason: z.string().max(500).optional(),
  final_percent: z.coerce.number().min(0).max(DISCOUNT.MAX_PERCENT).optional(),
});
