import { z } from 'zod';

const timeString = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/u).optional();

export const updatePrefsSchema = z.object({
  in_app: z.boolean().optional(),
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
  push: z.boolean().optional(),
  digest_frequency: z.enum(['immediate', 'hourly', 'daily']).optional(),
  quiet_hours_start: timeString,
  quiet_hours_end: timeString,
  quiet_hours_tz: z.string().optional(),
  event_overrides: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
});
