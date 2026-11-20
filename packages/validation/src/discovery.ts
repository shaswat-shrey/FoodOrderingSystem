import { z } from 'zod';
import { queryBoolean } from './catalog';
import { latSchema, lngSchema } from './geo';

export const DISCOVERY_SORTS = [
  'recommended',
  'rating',
  'eta',
  'distance',
  'cost_asc',
  'cost_desc',
  'popularity',
] as const;
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug')
  .max(60);

/** FR-DISC-001…004, 008. Unknown parameters are rejected (strict). */
export const discoveryListQuery = z
  .object({
    lat: latSchema,
    lng: lngSchema,
    cuisines: z
      .string()
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(z.array(slug).min(1).max(10))
      .optional(),
    minRating: z.enum(['3.5', '4.0', '4.5']).transform(Number).optional(),
    maxEta: z.coerce.number().int().min(10).max(120).optional(),
    maxDeliveryFee: z.coerce.number().int().min(0).max(100_000).optional(),
    priceMin: z.coerce.number().int().min(0).max(10_000_000).optional(),
    priceMax: z.coerce.number().int().min(0).max(10_000_000).optional(),
    offers: queryBoolean.optional(),
    pureVeg: queryBoolean.optional(),
    vegan: queryBoolean.optional(),
    openNow: queryBoolean.optional(),
    vegOnly: queryBoolean.optional(),
    maxDistance: z.coerce.number().min(0.5).max(15).optional(),
    sort: z.enum(DISCOVERY_SORTS).default('recommended'),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine((q) => q.priceMin === undefined || q.priceMax === undefined || q.priceMin <= q.priceMax, {
    message: 'priceMin must not exceed priceMax',
    path: ['priceMin'],
  });

export type DiscoveryListQuery = z.infer<typeof discoveryListQuery>;

export const discoveryLocationQuery = z
  .object({ lat: latSchema, lng: lngSchema, vegOnly: queryBoolean.optional() })
  .strict();
export const slugParams = z.object({ slug }).strict();
export const collectionQuery = z
  .object({
    lat: latSchema,
    lng: lngSchema,
    vegOnly: queryBoolean.optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
