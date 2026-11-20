import { haversineM } from './distance';
import type { LatLng, RouteEstimate, RoutingProvider } from './types';

/**
 * BR-GEO-003 / IF-GEO-002 fallback used until a routing provider is chosen
 * (OD-13): road distance ≈ straight line × road factor; duration at the
 * city-average motorbike speed. Settings are read per call so changes apply.
 */
export class EstimatedRouting implements RoutingProvider {
  constructor(private readonly settings: () => Promise<{ roadFactor: number; kmph: number }>) {}

  async route(origin: LatLng, destination: LatLng): Promise<RouteEstimate> {
    const { roadFactor, kmph } = await this.settings();
    const distanceM = Math.round(haversineM(origin, destination) * roadFactor);
    return {
      distanceM,
      durationS: Math.round(distanceM / ((kmph * 1000) / 3600)),
      source: 'estimate',
    };
  }
}
