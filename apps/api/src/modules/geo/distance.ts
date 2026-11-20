import type { LatLng } from './types';

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * FR-ADDR-006: India's extent as a bounding box (mainland plus Andaman &
 * Nicobar and Lakshadweep). A box, not the exact border: it rejects pins that
 * are clearly abroad (or 0,0) without shipping a boundary dataset.
 */
export function isInIndia({ lat, lng }: LatLng): boolean {
  return lat >= 6.5 && lat <= 37.2 && lng >= 68.0 && lng <= 97.5;
}
