export interface LatLng {
  lat: number;
  lng: number;
}

/** A resolved address, as returned by every geocoding call (IF-GEO-001). */
export interface GeoAddress extends LatLng {
  formatted: string;
  line2: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string | null;
}

export interface PlaceSuggestion {
  placeId: string;
  title: string;
  subtitle: string;
  distanceM: number | null;
}

/** IF-GEO-001. Implementations throw on provider failure; GeoService maps that to GEO_PROVIDER_UNAVAILABLE. */
export interface GeocodingProvider {
  readonly name: string;
  autocomplete(
    query: string,
    bias: LatLng | null,
    sessionToken?: string,
  ): Promise<PlaceSuggestion[]>;
  placeDetails(placeId: string): Promise<GeoAddress | null>;
  reverse(point: LatLng): Promise<GeoAddress | null>;
  geocode(address: {
    line1?: string;
    line2?: string;
    area: string;
    city: string;
    pincode?: string;
  }): Promise<GeoAddress | null>;
}

export interface RouteEstimate {
  distanceM: number;
  durationS: number;
  /** `estimate` = haversine × road factor at average speed (no routing provider). */
  source: 'routing' | 'estimate';
}

/** IF-GEO-002 (route only; matrix is CORE). */
export interface RoutingProvider {
  route(origin: LatLng, destination: LatLng): Promise<RouteEstimate>;
}
