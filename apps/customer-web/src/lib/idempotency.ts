import { useRef } from 'react';

/**
 * One Idempotency-Key per logical request: retries of the same `scope` reuse the
 * key (so a lost response can't double-order), a new scope gets a fresh one.
 */
export function useIdempotencyKey() {
  const ref = useRef<{ scope: string; key: string } | null>(null);
  return (scope: string) => {
    if (ref.current?.scope !== scope) ref.current = { scope, key: globalThis.crypto.randomUUID() };
    return ref.current.key;
  };
}
