import { z } from 'zod';
import { idSchema } from './common';
import { latSchema, lngSchema } from './geo';

/** BR-CART-006: plain text, HTML stripped, ≤ 250 characters. */
export const instructionsSchema = z
  .string()
  .transform((v) =>
    v
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  .pipe(z.string().max(250, 'Keep instructions under 250 characters'));

const lineConfig = {
  variantId: idSchema.optional(),
  optionIds: z.array(idSchema).max(30).default([]),
  instructions: instructionsSchema.optional(),
};

/** API-CART-002 (FR-CART-001). No prices: the server prices everything (FR-PRICE-002). */
export const addCartItemBody = z
  .object({
    branchId: idSchema,
    foodItemId: idSchema,
    ...lineConfig,
    quantity: z.number().int().min(1).max(20),
    replaceCart: z.boolean().default(false),
  })
  .strict();

/** API-CART-003: 0 removes the line. */
export const updateCartQuantityBody = z
  .object({
    quantity: z.number().int().min(0).max(20),
    version: z.number().int().min(0).optional(),
  })
  .strict();

/** API-CART-004 (FR-CART-004) */
export const replaceCartLineBody = z
  .object({
    ...lineConfig,
    quantity: z.number().int().min(1).max(20).optional(),
    version: z.number().int().min(0).optional(),
  })
  .strict();

/** API-CART-007 (FR-CART-007) */
export const patchCartBody = z
  .object({
    instructions: instructionsSchema.nullable().optional(),
    noCutlery: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const cartLineParams = z.object({ lineId: idSchema }).strict();

/** Tip in whole rupees as paise, ₹0–₹500 (BR-PRICE-008). */
export const tipSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(50_000)
  .refine((v) => v % 100 === 0, 'Tips are in whole rupees');

/** Where to price delivery: a saved address, or a location (FR-CART-008). */
export const cartPreviewQuery = z
  .object({
    addressId: idSchema.optional(),
    lat: latSchema.optional(),
    lng: lngSchema.optional(),
    tip: tipSchema.optional(),
  })
  .strict()
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), {
    message: 'Send both lat and lng, or neither',
    path: ['lat'],
  })
  .refine((q) => !(q.addressId && q.lat !== undefined), {
    message: 'Send an address or a location, not both',
    path: ['addressId'],
  });

/** API-CART-012 (FR-CART-011): a guest's local draft. */
export const mergeCartBody = z
  .object({
    branchId: idSchema,
    lines: z
      .array(
        z
          .object({
            foodItemId: idSchema,
            ...lineConfig,
            quantity: z.number().int().min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    replaceCart: z.boolean().default(false),
  })
  .strict();

export type AddCartItemBody = z.infer<typeof addCartItemBody>;
export type MergeCartBody = z.infer<typeof mergeCartBody>;
export type ReplaceCartLineBody = z.infer<typeof replaceCartLineBody>;
