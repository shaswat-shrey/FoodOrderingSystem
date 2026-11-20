import { haversineM } from './distance';
import type { GeoAddress, GeocodingProvider, LatLng, PlaceSuggestion } from './types';

interface Place extends LatLng {
  id: string;
  name: string;
  area: string;
  pincode: string;
}

/**
 * Pilot-city gazetteer for development and tests (IF-GEO-001 `MockGeocoder`).
 * Real Bengaluru localities with approximate centres; landmark names are
 * generic. Some lie outside the seeded delivery zones on purpose.
 */
const PLACES: Place[] = [
  {
    id: 'koramangala-5th-block',
    name: 'Koramangala 5th Block',
    area: 'Koramangala',
    pincode: '560095',
    lat: 12.9352,
    lng: 77.6245,
  },
  {
    id: 'koramangala-1st-block',
    name: 'Koramangala 1st Block',
    area: 'Koramangala',
    pincode: '560034',
    lat: 12.9279,
    lng: 77.6271,
  },
  {
    id: 'hsr-layout-sector-1',
    name: 'HSR Layout Sector 1',
    area: 'HSR Layout',
    pincode: '560102',
    lat: 12.9121,
    lng: 77.6446,
  },
  {
    id: 'hsr-layout-sector-7',
    name: 'HSR Layout Sector 7',
    area: 'HSR Layout',
    pincode: '560102',
    lat: 12.9081,
    lng: 77.6476,
  },
  {
    id: 'ejipura',
    name: 'Ejipura Main Road',
    area: 'Ejipura',
    pincode: '560047',
    lat: 12.9431,
    lng: 77.6293,
  },
  {
    id: 'indiranagar-100ft',
    name: '100 Feet Road, Indiranagar',
    area: 'Indiranagar',
    pincode: '560038',
    lat: 12.9719,
    lng: 77.6412,
  },
  {
    id: 'indiranagar-12th-main',
    name: '12th Main, Indiranagar',
    area: 'Indiranagar',
    pincode: '560038',
    lat: 12.9698,
    lng: 77.6387,
  },
  {
    id: 'domlur',
    name: 'Domlur Layout',
    area: 'Domlur',
    pincode: '560071',
    lat: 12.9609,
    lng: 77.6387,
  },
  {
    id: 'btm-layout',
    name: 'BTM Layout 2nd Stage',
    area: 'BTM Layout',
    pincode: '560076',
    lat: 12.9166,
    lng: 77.6101,
  },
  { id: 'mg-road', name: 'MG Road', area: 'MG Road', pincode: '560001', lat: 12.9756, lng: 77.605 },
  {
    id: 'jayanagar-4th-block',
    name: 'Jayanagar 4th Block',
    area: 'Jayanagar',
    pincode: '560011',
    lat: 12.925,
    lng: 77.5838,
  },
  {
    id: 'whitefield',
    name: 'Whitefield Main Road',
    area: 'Whitefield',
    pincode: '560066',
    lat: 12.9698,
    lng: 77.75,
  },
];

const CITY = 'Bengaluru';
const STATE = 'Karnataka';
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function toAddress(place: Place, at: LatLng = place): GeoAddress {
  return {
    lat: at.lat,
    lng: at.lng,
    formatted: `${place.name}, ${CITY} ${place.pincode}`,
    line2: place.name,
    area: place.area,
    city: CITY,
    state: STATE,
    pincode: place.pincode,
  };
}

export class MockGeocoder implements GeocodingProvider {
  readonly name = 'mock';

  async autocomplete(query: string, bias: LatLng | null): Promise<PlaceSuggestion[]> {
    const tokens = normalize(query).split(' ').filter(Boolean);
    return PLACES.filter((p) => {
      const hay = normalize(`${p.name} ${p.area} ${p.pincode}`);
      return tokens.every((t) => hay.includes(t));
    })
      .map((p) => ({
        placeId: `mock:${p.id}`,
        title: p.name,
        subtitle: `${p.area}, ${CITY}`,
        distanceM: bias ? Math.round(haversineM(bias, p)) : null,
      }))
      .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0) || a.title.localeCompare(b.title))
      .slice(0, 5);
  }

  async placeDetails(placeId: string): Promise<GeoAddress | null> {
    const place = PLACES.find((p) => `mock:${p.id}` === placeId);
    return place ? toAddress(place) : null;
  }

  /** Nearest known locality within 3 km, at the exact coordinates given. */
  async reverse(point: LatLng): Promise<GeoAddress | null> {
    let best: { place: Place; d: number } | null = null;
    for (const place of PLACES) {
      const d = haversineM(point, place);
      if (!best || d < best.d) best = { place, d };
    }
    return best && best.d <= 3000 ? toAddress(best.place, point) : null;
  }

  async geocode(address: {
    line1?: string;
    line2?: string;
    area: string;
    city: string;
    pincode?: string;
  }): Promise<GeoAddress | null> {
    if (normalize(address.city) !== normalize(CITY) && normalize(address.city) !== 'bangalore')
      return null;
    const text = normalize(`${address.line2 ?? ''} ${address.area}`);
    const candidates = PLACES.filter(
      (p) =>
        text.includes(normalize(p.area)) || normalize(p.name).includes(normalize(address.area)),
    );
    const match =
      candidates.find((p) => text.includes(normalize(p.name))) ??
      candidates.find((p) => !address.pincode || p.pincode === address.pincode) ??
      candidates[0];
    return match ? toAddress(match) : null;
  }
}

/** `GEO_PROVIDER=none`: every call fails, so callers take the manual-pin path. */
export class UnavailableGeocoder implements GeocodingProvider {
  readonly name = 'none';
  private fail(): never {
    throw new Error('no geocoding provider configured');
  }
  async autocomplete(): Promise<PlaceSuggestion[]> {
    this.fail();
  }
  async placeDetails(): Promise<GeoAddress | null> {
    this.fail();
  }
  async reverse(): Promise<GeoAddress | null> {
    this.fail();
  }
  async geocode(): Promise<GeoAddress | null> {
    this.fail();
  }
}
