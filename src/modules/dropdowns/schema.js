import { z } from 'zod';

export const DROPDOWN_TYPES = [
  'stages',
  'sub-stages',
  'channels',
  'sources',
  'campaigns',
  'mediums',
  'countries',
  'states',
  'genders',
  'degrees',
  'specializations',
  'universities',
];

export const typeParam = z.object({ type: z.enum(DROPDOWN_TYPES) });
export const typeIdParam = z.object({ type: z.enum(DROPDOWN_TYPES), id: z.string().uuid() });

export const itemCreateSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  order_index: z.number().int().optional(),
  color: z.string().optional(),
  is_terminal: z.boolean().optional(),
  stage_id: z.string().uuid().optional(),
  is_default: z.boolean().optional(),
  country_id: z.string().uuid().optional(),
  level: z.string().optional(),
  iso: z.string().optional(),
});

export const itemUpdateSchema = itemCreateSchema.partial();

export const reorderSchema = z.object({
  order: z.array(z.object({ id: z.string().uuid(), order_index: z.number().int() })),
});
