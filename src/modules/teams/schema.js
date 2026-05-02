import { z } from 'zod';

export const createTeamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  manager_id: z.string().uuid().optional(),
  parent_team_id: z.string().uuid().optional(),
});

export const updateTeamSchema = createTeamSchema.partial();

export const idParam = z.object({ id: z.string().uuid() });
export const memberParam = z.object({ id: z.string().uuid(), user_id: z.string().uuid() });

export const addMemberSchema = z.object({ user_id: z.string().uuid() });
