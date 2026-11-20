import { z } from 'zod';
import { idSchema } from './common';
import { latSchema, lngSchema } from './geo';

/** "true"/"false" in query strings. */
export const queryBoolean = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Optional location: both or neither. */
const optionalLocation = {
  lat: latSchema.optional(),
  lng: lngSchema.optional(),
};
const bothOrNeither = (q: { lat?: number; lng?: number }) =>
  (q.lat === undefined) === (q.lng === undefined);
const locationMessage = { message: 'Send both lat and lng, or neither', path: ['lat'] };

export const restaurantParams = z.object({ restaurantId: idSchema }).strict();
export const branchParams = z.object({ branchId: idSchema }).strict();
export const branchItemParams = z.object({ branchId: idSchema, itemId: idSchema }).strict();

export const optionalLocationQuery = z
  .object(optionalLocation)
  .strict()
  .refine(bothOrNeither, locationMessage);
export const requiredLocationQuery = z.object({ lat: latSchema, lng: lngSchema }).strict();

export const menuQuery = z.object({ vegOnly: queryBoolean.optional() }).strict();

export const MENU_ITEM_FLAGS = [
  'bestseller',
  'recommended',
  'special',
  'vegan',
  'jain',
  'gluten-free',
] as const;
export const menuItemsQuery = z
  .object({
    categoryId: idSchema.optional(),
    diet: z.enum(['VEG', 'NON_VEG', 'EGG']).optional(),
    /** Comma-separated, all must match. */
    flags: z
      .string()
      .transform((v) =>
        v
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.enum(MENU_ITEM_FLAGS)).max(MENU_ITEM_FLAGS.length))
      .optional(),
    q: z.string().trim().min(1).max(100).optional(),
    available: queryBoolean.optional(),
  })
  .strict();
