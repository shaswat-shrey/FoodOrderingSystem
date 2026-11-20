import { useEffect, useRef, useState } from 'react';
import type { LiveEnvelope, LiveStatus, Realtime } from './realtime';

/** Calls `handler` for each of `events` while mounted (latest handler, no resubscribe churn). */
export function useLiveEvent(
  realtime: Realtime,
  events: string | string[],
  handler: (envelope: LiveEnvelope) => void,
) {
  const ref = useRef(handler);
  ref.current = handler;
  const key = Array.isArray(events) ? events.join('|') : events;
  useEffect(() => {
    const offs = key.split('|').map((e) => realtime.on(e, (env) => ref.current(env)));
    return () => offs.forEach((off) => off());
  }, [realtime, key]);
}

/** Joins a resource room while mounted (and after every reconnect). */
export function useLiveSubscription(
  realtime: Realtime,
  type: string,
  id: string | null | undefined,
) {
  useEffect(() => {
    if (!id && ['order', 'branch-orders', 'branch-kds', 'delivery', 'zone'].includes(type)) return;
    const sub = realtime.subscribe(type, id ?? undefined);
    return () => sub.unsubscribe();
  }, [realtime, type, id]);
}

/** Connection status, e.g. to show an offline banner or speed up polling (FR-RT-022). */
export function useLiveStatus(realtime: Realtime): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(realtime.status());
  useEffect(() => {
    setStatus(realtime.status());
    const off = realtime.onStatus(setStatus);
    return () => {
      off();
    };
  }, [realtime]);
  return status;
}

/** Runs `onReconnect` when the socket comes back, so screens refetch snapshots (FR-RT-020). */
export function useLiveReconnect(realtime: Realtime, onReconnect: () => void) {
  const ref = useRef(onReconnect);
  ref.current = onReconnect;
  useEffect(() => {
    let was = realtime.status();
    const off = realtime.onStatus((s) => {
      if (s === 'connected' && was !== 'connected' && was !== 'idle') ref.current();
      was = s;
    });
    return () => {
      off();
    };
  }, [realtime]);
}
