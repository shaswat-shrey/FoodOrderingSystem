import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { createRealtime, type LiveEnvelope } from './realtime';

/** A fake socket.io client socket. */
function fakeSocket() {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  let any: ((event: string, payload: unknown) => void) | null = null;
  const emitted: { event: string; payload: unknown }[] = [];
  const socket = {
    connected: false,
    on(event: string, fn: (...a: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return socket;
    },
    onAny(fn: (event: string, payload: unknown) => void) {
      any = fn;
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
    },
    timeout: () => ({
      emitWithAck: async (event: string, payload: unknown) => {
        emitted.push({ event, payload });
        return { ok: true };
      },
    }),
    disconnect: vi.fn(),
    // test controls
    fire(event: string, ...args: unknown[]) {
      if (event === 'connect') socket.connected = true;
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    push(event: string, envelope: LiveEnvelope) {
      any?.(event, envelope);
    },
    emitted,
  };
  return socket;
}

const user = {
  id: 'u1',
  fullName: 'A',
  email: null,
  phone: null,
  emailVerified: false,
  phoneVerified: true,
  status: 'ACTIVE' as const,
  roles: [],
  scope: 'FULL' as const,
  profileComplete: true,
};

function setup() {
  const client = createApiClient({ clientApp: 'CUSTOMER' });
  const socket = fakeSocket();
  const connect = vi.fn(() => socket);
  const live = createRealtime(client, { connect: connect as never });
  const signIn = (token: string) =>
    client.authStore.setState({
      status: 'signedIn',
      user,
      accessToken: token,
      accessTokenExpiresAt: null,
    });
  return { client, socket, connect, live, signIn };
}

const env = (eventId: string, version: number, data = {}): LiveEnvelope => ({
  eventId,
  event: 'order.status_changed',
  occurredAt: '',
  aggregate: { type: 'order', id: 'o1', version },
  data,
});

describe('client realtime (FR-RT-003, 020, 023, 025)', () => {
  it('connects on sign-in to the app namespace, re-subscribes on reconnect and refreshes the token', async () => {
    const { socket, connect, live, signIn, client } = setup();
    live.start();
    expect(connect).not.toHaveBeenCalled();
    signIn('t1');
    expect(connect).toHaveBeenCalledWith(
      '/customer',
      expect.objectContaining({ transports: ['websocket'] }),
    );
    live.subscribe('order', 'o1');
    socket.fire('connect');
    expect(socket.emitted).toContainEqual({
      event: 'subscribe',
      payload: { type: 'order', id: 'o1' },
    });
    signIn('t2');
    expect(socket.emitted).toContainEqual({ event: 'auth:refresh', payload: { token: 't2' } });
    socket.fire('disconnect');
    expect(live.status()).toBe('disconnected');
    socket.emitted.length = 0;
    socket.fire('connect');
    expect(socket.emitted).toContainEqual({
      event: 'subscribe',
      payload: { type: 'order', id: 'o1' },
    });
    client.authStore.setState({
      status: 'signedOut',
      user: null,
      accessToken: null,
      accessTokenExpiresAt: null,
    });
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('drops duplicate and older events', () => {
    const { socket, live, signIn } = setup();
    live.start();
    signIn('t1');
    const seen: number[] = [];
    live.on('order.status_changed', (e) => seen.push(e.aggregate.version));
    socket.push('order.status_changed', env('e2', 2));
    socket.push('order.status_changed', env('e2', 2)); // duplicate
    socket.push('order.status_changed', env('e1', 1)); // older
    socket.push('order.status_changed', env('e3', 3));
    expect(seen).toEqual([2, 3]);
  });
});
