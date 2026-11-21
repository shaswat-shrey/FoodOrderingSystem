import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'socket.io';
import { createLogger } from '../logger';
import { MemoryRateLimiter } from '../rate-limit';
import {
  createSocketServer,
  deliver,
  handleControl,
  SocketAuthError,
  type LocationFix,
  type SocketAuth,
} from './socket-server';

const logger = createLogger({ level: 'silent', service: 'api' });

/** Fake auth: tokens look like "<app>:<user>:<session>:<expiresInMs>". */
const revoked = new Set<string>();
const auth: SocketAuth = {
  async authenticate(token, app) {
    const [tokenApp, userId, sessionId, ttl] = token.split(':');
    if (tokenApp !== app || !userId || !sessionId) throw new Error('invalid');
    if (revoked.has(sessionId))
      throw new SocketAuthError('AUTH_SESSION_REVOKED', 'Your session has ended.');
    return { userId, sessionId, expiresAt: new Date(Date.now() + Number(ttl ?? 60_000)) };
  },
};

let httpServer: HttpServer;
let io: Server;
let url: string;
const clients: ClientSocket[] = [];

const ORDER = '0193b0b6-0000-7000-8000-000000000001';
const OTHER = '0193b0b6-0000-7000-8000-000000000002';
const fixes: { userId: string; fix: LocationFix }[] = [];
const acks: string[] = [];

async function start(expiryGraceMs = 60_000) {
  httpServer = createServer();
  io = createSocketServer(httpServer, {
    corsOrigins: ['http://localhost:5173'],
    logger,
    auth,
    limiter: new MemoryRateLimiter(),
    controlChannel: 'rt:control',
    expiryGraceMs,
    // Fake policy: u1 owns ORDER; partners get partner:<user>.
    rooms: {
      autoRooms: async (s) => (s.app === 'DELIVERY' ? [`partner:${s.userId}`] : []),
      authorize: async (s, r) =>
        r.type === 'order' && r.id === ORDER && s.userId === 'u1' ? `order:${r.id}` : null,
    },
    partner: {
      location: async (userId, fix) => {
        fixes.push({ userId, fix });
      },
      heartbeat: async () => undefined,
      offerAck: async (_userId, offerId) => {
        acks.push(offerId);
      },
    },
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
}

function client(namespace: string, token?: string, ip?: string) {
  const socket = connect(`${url}${namespace}`, {
    transports: ['websocket'],
    auth: token ? { token } : {},
    reconnection: false,
    ...(ip ? { extraHeaders: { 'X-Forwarded-For': ip } } : {}),
  });
  clients.push(socket);
  return socket;
}

const connected = (s: ClientSocket) =>
  new Promise<void>((resolve, reject) => {
    s.on('connect', () => resolve());
    s.on('connect_error', reject);
  });
const rejected = (s: ClientSocket) =>
  new Promise<Error & { data?: { code?: string } }>((resolve) => s.on('connect_error', resolve));
const disconnected = (s: ClientSocket) =>
  new Promise<string>((resolve) => s.on('disconnect', resolve));

beforeEach(async () => {
  revoked.clear();
  fixes.length = 0;
  acks.length = 0;
  await start();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

describe('socket gateway authentication (FR-RT-001..004)', () => {
  it('accepts a valid token for the namespace and joins personal and session rooms', async () => {
    const s = client('/customer', 'CUSTOMER:u1:s1:60000');
    await connected(s);
    const sockets = await io.of('/customer').in('user:u1').fetchSockets();
    expect(sockets).toHaveLength(1);
    expect(await io.of('/customer').in('session:s1').fetchSockets()).toHaveLength(1);
  });

  it.each<[string, string | undefined, string]>([
    ['/customer', undefined, 'AUTH_TOKEN_MISSING'],
    ['/admin', 'CUSTOMER:u1:s1:60000', 'AUTH_TOKEN_INVALID'], // audience must match the namespace
    ['/restaurant', 'garbage', 'AUTH_TOKEN_INVALID'],
  ])('rejects %s with %s', async (namespace, token, code) => {
    const error = await rejected(client(namespace, token));
    expect(error.data?.code).toBe(code);
  });

  it('rejects revoked sessions at handshake', async () => {
    revoked.add('s2');
    expect((await rejected(client('/customer', 'CUSTOMER:u2:s2:60000'))).data?.code).toBe(
      'AUTH_SESSION_REVOKED',
    );
  });

  it('disconnects a session when its revocation is broadcast, leaving other sessions connected', async () => {
    const phone = client('/customer', 'CUSTOMER:u3:s3a:60000');
    const laptop = client('/customer', 'CUSTOMER:u3:s3b:60000');
    await Promise.all([connected(phone), connected(laptop)]);
    const dropped = disconnected(phone);
    handleControl(io, JSON.stringify({ type: 'session.revoked', sessionId: 's3a' }), logger);
    expect(await dropped).toBe('io server disconnect');
    expect(laptop.connected).toBe(true);
  });

  it('drops sockets whose token expires without auth:refresh, and keeps refreshed ones', async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await start(0);
    const stale = client('/delivery', 'DELIVERY:u4:s4:300');
    const fresh = client('/delivery', 'DELIVERY:u5:s5:300');
    await Promise.all([connected(stale), connected(fresh)]);
    const ack = await fresh
      .timeout(1000)
      .emitWithAck('auth:refresh', { token: 'DELIVERY:u5:s5:60000' });
    expect(ack).toEqual({ ok: true });
    expect(await disconnected(stale)).toBe('io server disconnect');
    await new Promise((r) => setTimeout(r, 400));
    expect(fresh.connected).toBe(true);
  });

  it('rejects auth:refresh with a token for another session', async () => {
    const s = client('/customer', 'CUSTOMER:u6:s6:60000');
    await connected(s);
    const dropped = disconnected(s);
    const ack = await s
      .timeout(1000)
      .emitWithAck('auth:refresh', { token: 'CUSTOMER:u7:s7:60000' });
    expect(ack).toEqual({ ok: false, code: 'AUTH_TOKEN_INVALID' });
    await dropped;
  });

  it('rate-limits connection attempts per IP (FR-RT-007)', async () => {
    const results = await Promise.all(
      Array.from({ length: 21 }, () => rejected(client('/customer', 'ADMIN:x:y:0'))),
    );
    // Connections race, so check counts rather than order: 20 allowed attempts, 1 limited.
    expect(results.filter((e) => e.data?.code === 'RATE_LIMITED')).toHaveLength(1);
    expect(results.filter((e) => e.data?.code === 'AUTH_TOKEN_INVALID')).toHaveLength(20);
  });

  it('counts connections per client behind the reverse proxy, not per proxy address', async () => {
    // Many users reach the gateway through one proxy hop (X-Forwarded-For, trust proxy = 1).
    const users = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        rejected(client('/customer', 'ADMIN:x:y:0', `203.0.113.${i + 1}`)),
      ),
    );
    expect(users.filter((e) => e.data?.code === 'RATE_LIMITED')).toHaveLength(0);
    const one = await Promise.all(
      Array.from({ length: 21 }, () =>
        rejected(client('/customer', 'ADMIN:x:y:0', '198.51.100.7, 203.0.113.200')),
      ),
    );
    expect(one.filter((e) => e.data?.code === 'RATE_LIMITED')).toHaveLength(1);
  });
});

describe('rooms and events (FR-RT-010…014, §13.5)', () => {
  it('joins an authorized order room and answers FORBIDDEN alike for other and missing orders', async () => {
    const owner = client('/customer', 'CUSTOMER:u1:s1:60000');
    const other = client('/customer', 'CUSTOMER:u2:s2:60000');
    await Promise.all([connected(owner), connected(other)]);
    expect(
      await owner.timeout(1000).emitWithAck('subscribe', { type: 'order', id: ORDER }),
    ).toEqual({
      ok: true,
      room: `order:${ORDER}`,
    });
    const denied = await other.timeout(1000).emitWithAck('subscribe', { type: 'order', id: ORDER });
    const missing = await other
      .timeout(1000)
      .emitWithAck('subscribe', { type: 'order', id: OTHER });
    expect(denied).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(missing).toEqual(denied);
    expect(
      await other.timeout(1000).emitWithAck('subscribe', { type: 'order', id: 'nope' }),
    ).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
    });
  });

  it('delivers pushed events only to sockets in the rooms, in the right namespace', async () => {
    const owner = client('/customer', 'CUSTOMER:u1:s1:60000');
    const other = client('/customer', 'CUSTOMER:u2:s2:60000');
    await Promise.all([connected(owner), connected(other)]);
    await owner.timeout(1000).emitWithAck('subscribe', { type: 'order', id: ORDER });
    const got = new Promise((resolve) => owner.on('order.status_changed', resolve));
    let leaked = false;
    other.on('order.status_changed', () => (leaked = true));
    const envelope = { eventId: 'e1', event: 'order.status_changed', data: { to: 'ACCEPTED' } };
    deliver(
      io,
      JSON.stringify({
        namespace: '/customer',
        rooms: [`order:${ORDER}`],
        event: 'order.status_changed',
        envelope,
      }),
      logger,
    );
    expect(await got).toEqual(envelope);
    await new Promise((r) => setTimeout(r, 50));
    expect(leaked).toBe(false);
  });

  it('moves sockets between rooms on control messages (FR-RT-011)', async () => {
    const p = client('/delivery', 'DELIVERY:p1:s9:60000');
    await connected(p);
    await new Promise((r) => setTimeout(r, 50));
    const ns = io.of('/delivery');
    expect(await ns.in('partner:p1').fetchSockets()).toHaveLength(1);
    handleControl(
      io,
      JSON.stringify({
        type: 'rooms.join',
        namespace: '/delivery',
        target: 'partner:p1',
        room: 'delivery:d1',
      }),
      logger,
    );
    expect(await ns.in('delivery:d1').fetchSockets()).toHaveLength(1);
    handleControl(
      io,
      JSON.stringify({
        type: 'rooms.leave',
        namespace: '/delivery',
        target: 'partner:p1',
        room: 'delivery:d1',
      }),
      logger,
    );
    expect(await ns.in('delivery:d1').fetchSockets()).toHaveLength(0);
  });

  it('validates and rate-limits partner locations, and records offer acks', async () => {
    const p = client('/delivery', 'DELIVERY:p2:s10:60000');
    await connected(p);
    const fix = { lat: 12.93, lng: 77.62, accuracy: 9 };
    expect(await p.timeout(1000).emitWithAck('partner:location', fix)).toEqual({ ok: true });
    // FR-RT-014: one per 2 s.
    expect(await p.timeout(1000).emitWithAck('partner:location', fix)).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
    });
    expect(fixes).toEqual([{ userId: 'p2', fix }]);
    expect(await p.timeout(1000).emitWithAck('offer:ack', { offerId: 'o1' })).toEqual({ ok: true });
    expect(acks).toEqual(['o1']);
    // Customers have no partner events.
    const c = client('/customer', 'CUSTOMER:u3:s11:60000');
    await connected(c);
    await expect(c.timeout(300).emitWithAck('partner:location', fix)).rejects.toThrow();
  });

  it('rejects bad locations', async () => {
    const p = client('/delivery', 'DELIVERY:p3:s12:60000');
    await connected(p);
    expect(
      await p.timeout(1000).emitWithAck('partner:location', { lat: 200, lng: 1, accuracy: 1 }),
    ).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
    });
  });
});
