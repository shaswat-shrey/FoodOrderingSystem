import { Router } from 'express';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { byIp, rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import type { SettingsService } from '../config';
import type { GeoService } from '../geo';
import type { ServiceabilityService } from './serviceability.service';

export interface GeoRouterDeps {
  geo: GeoService;
  serviceability: ServiceabilityService;
  settings: SettingsService;
  limiter: RateLimiter;
}

/** API-GEO-001…005 (public: guests choose a location before signing in). */
export function geoRouter({ geo, serviceability, settings, limiter }: GeoRouterDeps): Router {
  const router = Router();
  router.use(requireClientApp());
  const searchLimit = rateLimit(limiter, {
    name: 'rl:search:ip',
    limit: 60,
    windowSeconds: 60,
    key: byIp,
  });
  const readLimit = rateLimit(limiter, {
    name: 'rl:read:ip',
    limit: 120,
    windowSeconds: 60,
    key: byIp,
  });

  router.get(
    '/autocomplete',
    searchLimit,
    handle({ query: schema.geoAutocompleteQuery }, async ({ query, res }) => {
      const bias =
        query.lat !== undefined && query.lng !== undefined
          ? { lat: query.lat, lng: query.lng }
          : null;
      sendOk(res, await geo.autocomplete(query.q, bias, query.sessionToken));
    }),
  );

  router.get(
    '/places/:placeId',
    readLimit,
    handle({ params: schema.geoPlaceParams }, async ({ params, res }) => {
      sendOk(res, await geo.placeDetails(params.placeId));
    }),
  );

  router.get(
    '/reverse',
    readLimit,
    handle({ query: schema.latLngQuery }, async ({ query, res }) => {
      sendOk(res, await geo.reverse(query));
    }),
  );

  router.get(
    '/serviceability',
    readLimit,
    handle({ query: schema.serviceabilityQuery }, async ({ query, res }) => {
      geo.assertInIndia(query);
      sendOk(res, await serviceability.check({ lat: query.lat, lng: query.lng }, query.branchId));
    }),
  );

  router.post(
    '/geocode',
    readLimit,
    handle({ body: schema.geocodeBody }, async ({ body, res }) => {
      const { pin, ...address } = body;
      if (pin) geo.assertInIndia(pin, 'pin');
      sendOk(res, await geo.geocode(address, pin, await settings.get('address.pinWarningMeters')));
    }),
  );

  return router;
}
