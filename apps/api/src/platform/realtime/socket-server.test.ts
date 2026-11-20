import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'socket.io';
import { createLogger } from '../logger';
import { MemoryRateLimiter } from '../rate-limit';
import {
  createSocketServer,
  handleControl,
  SocketAuthError,
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

async function start(expiryGraceMs = 60_000) {
  httpServer = createServer();
  io = createSocketServer(httpServer, {
    corsOrigins: ['http://localhost:5173'],
    logger,
    auth,
    limiter: new MemoryRateLimiter(),
    controlChannel: 'rt:control',
    expiryGraceMs,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
}

function client(namespace: string, token?: string) {
  const socket = connect(`${url}${namespace}`, {
    transports: ['websocket'],
    auth: token ? { token } : {},
    reconnection: false,
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
});
