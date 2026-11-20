const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Standard geohash; precision 6 ≈ 1.2 km × 0.6 km cells (FR-DISC-005 cache key). */
export function geohash(lat: number, lng: number, precision = 6): string {
  let latRange = [-90, 90];
  let lngRange = [-180, 180];
  let hash = '';
  let bits = 0;
  let value = 0;
  let even = true;
  while (hash.length < precision) {
    const range = even ? lngRange : latRange;
    const coord = even ? lng : lat;
    const mid = (range[0]! + range[1]!) / 2;
    value <<= 1;
    if (coord >= mid) {
      value |= 1;
      range[0] = mid;
    } else {
      range[1] = mid;
    }
    if (even) lngRange = range;
    else latRange = range;
    even = !even;
    if (++bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}
