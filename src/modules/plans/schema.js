import { z } from 'zod';

export const planIdParam = z.object({ id: z.string().uuid() });
