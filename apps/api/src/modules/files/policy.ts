import type { ClientApp, FilePurpose } from '@fos/db';

export type DetectedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

const MB = 1024 * 1024;
const IMAGES: DetectedType[] = ['image/jpeg', 'image/png', 'image/webp'];
const DOCS: DetectedType[] = ['application/pdf', 'image/jpeg', 'image/png'];

export interface PurposeRule {
  types: DetectedType[];
  maxBytes: number;
  visibility: 'PUBLIC' | 'PRIVATE';
  /** Apps whose users may upload this purpose (FR-FILE-001). */
  apps: ClientApp[];
  /** Public images get WebP derivatives (FR-FILE-003). */
  derivatives: boolean;
}

/** BR-FILE-001. SVG is never accepted (XSS). */
export const PURPOSES: Partial<Record<FilePurpose, PurposeRule>> = {
  AVATAR: {
    types: IMAGES,
    maxBytes: 5 * MB,
    visibility: 'PUBLIC',
    apps: ['CUSTOMER', 'RESTAURANT', 'DELIVERY', 'ADMIN'],
    derivatives: true,
  },
  RESTAURANT_LOGO: {
    types: IMAGES,
    maxBytes: 5 * MB,
    visibility: 'PUBLIC',
    apps: ['RESTAURANT', 'ADMIN'],
    derivatives: true,
  },
  RESTAURANT_COVER: {
    types: IMAGES,
    maxBytes: 10 * MB,
    visibility: 'PUBLIC',
    apps: ['RESTAURANT', 'ADMIN'],
    derivatives: true,
  },
  FOOD_IMAGE: {
    types: IMAGES,
    maxBytes: 5 * MB,
    visibility: 'PUBLIC',
    apps: ['RESTAURANT', 'ADMIN'],
    derivatives: true,
  },
  RESTAURANT_DOCUMENT: {
    types: DOCS,
    maxBytes: 10 * MB,
    visibility: 'PRIVATE',
    apps: ['RESTAURANT'],
    derivatives: false,
  },
  PARTNER_DOCUMENT: {
    types: DOCS,
    maxBytes: 10 * MB,
    visibility: 'PRIVATE',
    apps: ['DELIVERY'],
    derivatives: false,
  },
  PARTNER_PHOTO: {
    types: IMAGES,
    maxBytes: 5 * MB,
    visibility: 'PRIVATE',
    apps: ['DELIVERY'],
    derivatives: false,
  },
  DELIVERY_PROOF: {
    types: IMAGES,
    maxBytes: 5 * MB,
    visibility: 'PRIVATE',
    apps: ['DELIVERY'],
    derivatives: false,
  },
  SUPPORT_ATTACHMENT: {
    types: [...IMAGES, 'application/pdf'],
    maxBytes: 5 * MB,
    visibility: 'PRIVATE',
    apps: ['CUSTOMER', 'RESTAURANT', 'DELIVERY'],
    derivatives: false,
  },
};

export const MAX_UPLOAD_BYTES = 10 * MB;

/** FR-FILE-002: type from magic bytes, never from the name or the client's MIME type. */
export function detectType(head: Buffer): DetectedType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return 'image/jpeg';
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    head.length >= 12 &&
    head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (head.length >= 5 && head.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

export const EXTENSION: Record<DetectedType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** FR-FILE-003 derivative widths. */
export const DERIVATIVES = { thumb: 160, card: 480, hero: 1200 } as const;
export type DerivativeName = keyof typeof DERIVATIVES;
