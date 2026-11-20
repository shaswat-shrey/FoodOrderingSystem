import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'socket.io';
import { createLogger } from '../logger';
import { createSocketServer } from './socket-server';

let httpServer: HttpServer;
let io: Server;
let url: string;

beforeAll(async () => {
  httpServer = createServer();
  io = createSocketServer(httpServer, {
    corsOrigins: ['http://localhost:5173'],
    logger: createLogger({ level: 'silent', service: 'api' }),
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

describe('socket gateway (Phase 2: deny by default)', () => {
  it.each(['/customer', '/restaurant', '/delivery', '/admin'])(
    'rejects connections to %s until handshake auth exists',
    async (namespace) => {
      const client = connect(`${url}${namespace}`, {
        transports: ['websocket'],
        auth: { token: 'anything' },
        reconnection: false,
      });
      const error = await new Promise<Error & { data?: { code?: string } }>((resolve) =>
        client.on('connect_error', resolve),
      );
      client.close();
      expect(error.message).toBe('AUTH_TOKEN_INVALID');
      expect(error.data?.code).toBe('AUTH_TOKEN_INVALID');
    },
  );
});
