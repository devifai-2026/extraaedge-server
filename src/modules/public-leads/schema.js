import { z } from 'zod';

// Body the speedupinfotech.com "Free Demo" form posts. Mirrors the FE's own
// validation (name >=3 chars letters/spaces only; phone is digits-only,
// 7-15 chars — international, not restricted to the Indian 10-digit format)
// so a request that already passed client-side checks never bounces here on
// a stricter server rule.
//
// The form is now two steps: step 1 posts {name, phone}; step 2 (after the
// visitor picks a course) posts {name, phone, interest} as a SECOND request
// with the same phone. `interest` is optional here so step 1 still validates.
export const publicLeadCreateSchema = z.object({
  name: z.string().trim().min(3).max(200).regex(/^[a-zA-Z\s]+$/, 'Enter a valid full name'),
  phone: z.string().trim().regex(/^\d{7,15}$/, 'Enter a valid phone number'),
  interest: z.string().trim().min(1).max(200).optional(),
});

// One row of the SI HR Meta Lead Ads Google Sheet, posted by the sheet's Apps
// Script as { row: { <header>: <cell>, ... } }. Headers are Meta's export
// columns (full_name, phone_number, email, city, campaign_name, platform, ...)
// plus one column per custom form question, so the shape is deliberately
// open — the service picks the known keys and keeps the rest as remarks.
export const sheetLeadSchema = z.object({
  row: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
