import { io, type Socket } from 'socket.io-client';
import { SOCKET_NAMESPACES } from '@fos/shared';
import type { ApiClient } from './client';

/** SRS §13.4 envelope as clients receive it. */
export interface LiveEnvelope<T = Record<string, unknown>> {
  eventId: string;
  event: string;
  occurredAt: string;
  aggregate: { type: string; id: string; version: number };
  data: T;
}

export type LiveStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';
type Handler = (envelope: LiveEnvelope) => void;
type Ack = { ok: boolean; code?: string; room?: string };

export interface RealtimeOptions {
  /** Origin of the API; same origin (through the dev proxy / reverse proxy) by default. */
  url?: string;
  /** For tests. */
  connect?: typeof io;
}

const SEEN_MAX = 500; // FR-RT-025

/**
 * The app's socket (SRS §13): connects while signed in, sends the fresh access
 * token on every refresh (FR-RT-003), reconnects with backoff and jitter, re-sends
 * subscriptions and tells listeners to refetch (FR-RT-020), and drops duplicate
 * or older events (FR-RT-023, 025). REST stays the source of truth.
 */
export function createRealtime(client: ApiClient, options: RealtimeOptions = {}) {
  const connect = options.connect ?? io;
  const handlers = new Map<string, Set<Handler>>();
  const statusListeners = new Set<(s: LiveStatus) => void>();
  const subscriptions = new Map<string, { type: string; id?: string }>();
  const seen = new Set<string>();
  const order: string[] = [];
  const versions = new Map<string, number>();
  let socket: Socket | null = null;
  let status: LiveStatus = 'idle';
  let token: string | null = null;

  const setStatus = (s: LiveStatus) => {
    status = s;
    for (const l of statusListeners) l(s);
  };

  const accept = (event: string, envelope: LiveEnvelope) => {
    if (!envelope || typeof envelope !== 'object' || !envelope.eventId) return false;
    const key = `${envelope.eventId}:${event}`;
    if (seen.has(key)) return false;
    seen.add(key);
    order.push(key);
    if (order.length > SEEN_MAX) seen.delete(order.shift()!);
    const { type, id, version } = envelope.aggregate ?? { type: '', id: '', version: 0 };
    if (version > 0) {
      const agg = `${type}:${id}`;
      if (version < (versions.get(agg) ?? 0)) return false;
      versions.set(agg, version);
    }
    return true;
  };

  const send = (sub: { type: string; id?: string }) =>
    socket
      ?.timeout(5_000)
      .emitWithAck('subscribe', sub)
      .catch(() => ({ ok: false })) as Promise<Ack> | undefined;

  const open = () => {
    if (socket) return;
    setStatus('connecting');
    socket = connect(`${options.url ?? ''}${SOCKET_NAMESPACES[client.clientApp]}`, {
      transports: ['websocket'],
      // Read at every (re)connect so a refreshed token is used.
      auth: (cb) => cb({ token: client.authStore.getState().accessToken }),
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
    });
    socket.on('connect', () => {
      setStatus('connected');
      for (const sub of subscriptions.values()) void send(sub);
    });
    socket.on('disconnect', () => setStatus('disconnected'));
    socket.on('connect_error', () => setStatus('disconnected'));
    socket.onAny((event: string, envelope: LiveEnvelope) => {
      if (!accept(event, envelope)) return;
      for (const h of handlers.get(event) ?? []) h(envelope);
      for (const h of handlers.get('*') ?? []) h(envelope);
    });
  };

  const close = () => {
    socket?.disconnect();
    socket = null;
    setStatus('idle');
  };

  // Follow the session: connect when signed in, re-authorize on refresh, close on sign-out.
  const follow = () => {
    const state = client.authStore.getState();
    const next = state.status === 'signedIn' ? state.accessToken : null;
    if (!next) {
      token = null;
      close();
      return;
    }
    if (!socket) open();
    else if (next !== token && socket.connected) socket.emit('auth:refresh', { token: next });
    token = next;
  };
  client.authStore.subscribe(follow);

  return {
    /** Starts following the session (call once at app start). */
    start: follow,
    stop: close,
    status: () => status,
    onStatus(listener: (s: LiveStatus) => void) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    /** Listen to one event name ('*' for all). */
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    /** Asks the server to join a resource room; kept across reconnects. */
    subscribe(type: string, id?: string) {
      const key = `${type}:${id ?? ''}`;
      const sub = id ? { type, id } : { type };
      subscriptions.set(key, sub);
      const pending = socket?.connected ? send(sub) : undefined;
      return {
        ready: pending ?? Promise.resolve<Ack>({ ok: false, code: 'NOT_CONNECTED' }),
        unsubscribe: () => {
          subscriptions.delete(key);
          socket?.emit('unsubscribe', sub);
        },
      };
    },
    /** Client → server event with an ack (partner:location, offer:ack). */
    async emit(event: string, payload: unknown): Promise<Ack> {
      if (!socket?.connected) return { ok: false, code: 'NOT_CONNECTED' };
      return (socket.timeout(5_000).emitWithAck(event, payload) as Promise<Ack>).catch(() => ({
        ok: false,
        code: 'TIMEOUT',
      }));
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
