import { z } from 'zod';

const hm = z.string().regex(/^\d{2}:\d{2}$/u, 'HH:MM format').nullable().optional();

export const businessHoursSchema = z.object({
  hours: z.array(
    z.object({
      day_of_week: z.number().int().min(0).max(6),
      is_open: z.boolean(),
      open_time: hm,
      close_time: hm,
    }),
  ),
  timezone: z.string().optional(),
});

export const holidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  name: z.string().min(1),
  is_full_day: z.boolean().default(true),
});

export const idParam = z.object({ id: z.string().uuid() });

export const nextMomentQuery = z.object({
  from: z.string().datetime().optional(),
});
