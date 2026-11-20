import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

// React Router's data routers build a fetch Request with the page's AbortSignal.
// Under jsdom that signal is jsdom's class, which Node's Request rejects, so
// in-test navigations (e.g. <Navigate>) fail. Tests don't need the signal.
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.signal) {
      const { signal: _signal, ...rest } = init;
      super(input, rest);
    } else super(input, init);
  }
} as typeof Request;
