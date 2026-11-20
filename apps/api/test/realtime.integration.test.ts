import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'socket.io';
import { createSocketAuth, REALTIME_CONTROL_CHANNEL } from '../src/modules/auth';
import { createSocketServer } from '../src/platform/realtime/socket-server';
import { createTestContext, integrationEnabled, signUpCustomer, type TestContext } from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let io: Server;
let url: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  const httpServer = createServer(ctx.app);
  io = createSocketServer(httpServer, {
    corsOrigins: ['http://localhost:5173'],
    logger: ctx.container.logger,
    auth: createSocketAuth(ctx.container.tokens, ctx.container.sessions),
    limiter: ctx.container.limiter,
    redis: ctx.redis.core,
    controlChannel: REALTIME_CONTROL_CHANNEL,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!integrationEnabled) return;
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await ctx.close();
});

suite('real-time session security (FR-RT-002/004, AC-AUTH-008)', () => {
  it('authenticates sockets with real tokens and disconnects them on logout-all via Redis', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const socket = connect(`${url}/customer`, {
      transports: ['websocket'],
      auth: { token: b.token },
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });
    const dropped = new Promise<string>((resolve) => socket.on('disconnect', resolve));
    expect((await b.post('/auth/logout-all', { keepCurrent: false })).status).toBe(200);
    expect(await dropped).toBe('io server disconnect');

    const retry = connect(`${url}/customer`, {
      transports: ['websocket'],
      auth: { token: b.token },
      reconnection: false,
    });
    const error = await new Promise<Error & { data?: { code?: string } }>((resolve) =>
      retry.on('connect_error', resolve),
    );
    expect(error.data?.code).toBe('AUTH_SESSION_REVOKED');
    retry.close();
  });

  it('refuses a customer token on the restaurant namespace', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const socket = connect(`${url}/restaurant`, {
      transports: ['websocket'],
      auth: { token: b.token },
      reconnection: false,
    });
    const error = await new Promise<Error & { data?: { code?: string } }>((resolve) =>
      socket.on('connect_error', resolve),
    );
    expect(error.data?.code).toBe('AUTH_TOKEN_INVALID');
    socket.close();
  });
});
