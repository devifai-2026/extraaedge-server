import { z } from 'zod';

// Body the speedupinfotech.com "Free Demo" form posts. Mirrors the FE's own
// validation (name >=3 chars letters/spaces only, 10-digit Indian mobile
// starting 6-9) so a request that already passed client-side checks never
// bounces here on a stricter server rule.
//
// The form is now two steps: step 1 posts {name, phone}; step 2 (after the
// visitor picks a course) posts {name, phone, interest} as a SECOND request
// with the same phone. `interest` is optional here so step 1 still validates.
export const publicLeadCreateSchema = z.object({
  name: z.string().trim().min(3).max(200).regex(/^[a-zA-Z\s]+$/, 'Enter a valid full name'),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  interest: z.string().trim().min(1).max(200).optional(),
});
