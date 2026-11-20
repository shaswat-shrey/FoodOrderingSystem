import { useSyncExternalStore } from 'react';
import type { LatLng } from '@fos/api-client';

/** Where the customer wants food delivered, kept for this browser session. */
export interface DeliveryLocation extends LatLng {
  /** Short label for the header, e.g. "Home · Koramangala". */
  label: string;
  /** A saved address, when one was picked (checkout pre-selects it). */
  addressId?: string | null;
}

const KEY = 'fos.customer.location';
const listeners = new Set<() => void>();

function read(): DeliveryLocation | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as DeliveryLocation;
    return Number.isFinite(value.lat) && Number.isFinite(value.lng) ? value : null;
  } catch {
    return null;
  }
}

let current: DeliveryLocation | null = read();

export function getDeliveryLocation(): DeliveryLocation | null {
  return current;
}

export function setDeliveryLocation(next: DeliveryLocation | null) {
  current = next;
  try {
    if (next) sessionStorage.setItem(KEY, JSON.stringify(next));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage can be unavailable (private mode); the location still lasts for this page.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDeliveryLocation(): DeliveryLocation | null {
  return useSyncExternalStore(subscribe, getDeliveryLocation, getDeliveryLocation);
}

/** The browser's current position, or an error message the customer can act on. */
export function currentPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Your browser can’t share its location. Enter it below instead.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error('We couldn’t get your location. Allow access or enter it below.')),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}
