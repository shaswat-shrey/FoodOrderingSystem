import { z } from 'zod';
import { fullNameSchema, otpCodeSchema } from './auth';
import { idSchema, indianMobileSchema } from './common';

/** Mirrors the database enums (packages/db identity/menu schema). */
export const DIETARY_TAGS = [
  'VEGAN',
  'JAIN',
  'GLUTEN_FREE',
  'DAIRY_FREE',
  'SPICY',
  'KETO',
  'HIGH_PROTEIN',
] as const;
export const ALLERGENS = [
  'GLUTEN',
  'CRUSTACEANS',
  'EGGS',
  'FISH',
  'PEANUTS',
  'SOY',
  'MILK',
  'TREE_NUTS',
  'CELERY',
  'MUSTARD',
  'SESAME',
  'SULPHITES',
  'LUPIN',
  'MOLLUSCS',
] as const;
/** English only at launch (SRS A-01); Hindi is added with its translations. */
export const LOCALES = ['en-IN'] as const;

export const updateProfileBody = z
  .object({ fullName: fullNameSchema.optional(), locale: z.enum(LOCALES).optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const updatePreferencesBody = z
  .object({
    vegOnlyDefault: z.boolean().optional(),
    dietaryTags: z.array(z.enum(DIETARY_TAGS)).max(DIETARY_TAGS.length).optional(),
    allergens: z.array(z.enum(ALLERGENS)).max(ALLERGENS.length).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const changeEmailBody = z
  .object({ email: z.email('Enter a valid email address').max(254) })
  .strict();
export const changePhoneBody = z.object({ phone: indianMobileSchema }).strict();
export const confirmPhoneChangeBody = z
  .object({ phone: indianMobileSchema, code: otpCodeSchema })
  .strict();
export const acceptConsentBody = z.object({ legalDocumentId: idSchema }).strict();
