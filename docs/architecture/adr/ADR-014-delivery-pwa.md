# ADR-014: Delivery partner app as an installable PWA first

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
The required stack is React web. Partners need GPS, push, camera and reliability on Android phones.

## Decision
Build `delivery-web` as a mobile-first installable PWA (service worker, Web Push, Wake Lock, geolocation watch, IndexedDB offline queue). Partners must keep the app foregrounded during active deliveries.

## Alternatives
React Native/Capacitor native app — reliable background location and push; outside the mandated stack for now. Capacitor wrapping of the same React app is the planned upgrade path if background tracking proves insufficient (risk R-05).

## Consequences
+ One codebase/stack; instant updates; no app-store dependency.
− Browsers throttle background geolocation; iOS push requires installed PWA (16.4+); location gaps when backgrounded are mitigated by stale detection and partner guidance.
