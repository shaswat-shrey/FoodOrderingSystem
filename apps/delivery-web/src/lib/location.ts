import { useEffect, useRef } from 'react';
import type { Fix } from '@fos/api-client';
import { partner } from './partner';

function toFix(p: GeolocationPosition): Fix {
  return {
    lat: p.coords.latitude,
    lng: p.coords.longitude,
    accuracyM: Math.round(p.coords.accuracy),
    recordedAt: new Date(p.timestamp).toISOString(),
    ...(p.coords.heading != null && !Number.isNaN(p.coords.heading)
      ? { heading: Math.round(p.coords.heading) % 360 }
      : {}),
    ...(p.coords.speed != null ? { speedKmh: Math.round(p.coords.speed * 3.6) } : {}),
  };
}

/** One fresh fix, for going online and stage geofences (FR-DP-010). */
export function currentFix(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This device can’t share its location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(toFix(p)),
      (e) =>
        reject(
          new Error(
            e.code === e.PERMISSION_DENIED
              ? 'Allow location access to go online.'
              : 'We couldn’t get your location. Move to open sky and try again.',
          ),
        ),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  });
}

/**
 * FR-TRK-001/002: while online, watch the position and send batches — every 5 s on a
 * delivery, every 30 s otherwise. Nothing is watched while offline.
 */
export function useLocationReporting(state: string | undefined) {
  const queue = useRef<Fix[]>([]);
  const online = state !== undefined && state !== 'OFFLINE';
  const everyMs = state === 'ON_DELIVERY' ? 5_000 : 30_000;
  useEffect(() => {
    if (!online || !('geolocation' in navigator)) return;
    const watch = navigator.geolocation.watchPosition(
      (p) => {
        queue.current.push(toFix(p));
        // FR-TRK-008: keep at most 5 minutes of points if sending keeps failing.
        if (queue.current.length > 60) queue.current.splice(0, queue.current.length - 60);
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 5_000 },
    );
    const timer = setInterval(() => {
      const points = queue.current.splice(0, 60);
      if (points.length)
        partner.sendLocations(points).catch(() => queue.current.unshift(...points));
    }, everyMs);
    return () => {
      navigator.geolocation.clearWatch(watch);
      clearInterval(timer);
    };
  }, [online, everyMs]);
}
