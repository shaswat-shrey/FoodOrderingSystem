import type { Redis } from 'ioredis';
import { redisReady } from '../redis';
import { SOCKET_NAMESPACES, uuidv7, type ClientApp } from '@fos/shared';
import type { Logger } from '../logger';
import type { RealtimeMessage } from './socket-server';

export const REALTIME_EVENTS_CHANNEL = 'rt:events';

/** SRS §13.4 envelope. */
export interface Envelope<T = Record<string, unknown>> {
  eventId: string;
  event: string;
  occurredAt: string;
  aggregate: { type: string; id: string; version: number };
  data: T;
}

export interface PushInput {
  app: ClientApp;
  rooms: string[];
  event: string;
  aggregate: { type: string; id: string; version: number };
  data: Record<string, unknown>;
  /** The outbox event id when the push follows one, so clients can de-duplicate retries. */
  eventId?: string;
  occurredAt?: Date;
}

/**
 * Pushes events to sockets on every API instance (FR-RT-006) and moves sockets
 * between rooms when authorization changes (FR-RT-011). Best effort: REST stays
 * authoritative, so a failed publish is logged, never thrown (FR-RT-022).
 */
export interface Realtime {
  push(input: PushInput): Promise<void>;
  join(app: ClientApp, target: string, room: string): Promise<void>;
  leave(app: ClientApp, target: string, room: string): Promise<void>;
}

export function envelopeOf(input: PushInput): Envelope {
  return {
    eventId: input.eventId ?? uuidv7(),
    event: input.event,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    aggregate: input.aggregate,
    data: input.data,
  };
}

export class RedisRealtime implements Realtime {
  constructor(
    private readonly redis: Redis,
    private readonly controlChannel: string,
    private readonly logger: Logger,
  ) {}

  async push(input: PushInput) {
    if (!input.rooms.length) return;
    // Sockets resync from REST when they reconnect; never wait for Redis here.
    if (!redisReady(this.redis))
      return this.logger.warn({ event: input.event }, 'realtime push skipped; redis unavailable');
    const message: RealtimeMessage = {
      namespace: SOCKET_NAMESPACES[input.app],
      rooms: input.rooms,
      event: input.event,
      envelope: envelopeOf(input),
    };
    await this.redis
      .publish(REALTIME_EVENTS_CHANNEL, JSON.stringify(message))
      .then(() => undefined)
      .catch((error: unknown) =>
        this.logger.warn({ err: error, event: input.event }, 'realtime push failed'),
      );
  }

  private async control(
    type: 'rooms.join' | 'rooms.leave',
    app: ClientApp,
    target: string,
    room: string,
  ) {
    if (!redisReady(this.redis))
      return this.logger.warn({ room }, 'realtime room change skipped; redis unavailable');
    await this.redis
      .publish(
        this.controlChannel,
        JSON.stringify({ type, namespace: SOCKET_NAMESPACES[app], target, room }),
      )
      .then(() => undefined)
      .catch((error: unknown) =>
        this.logger.warn({ err: error, room }, 'realtime room change failed'),
      );
  }

  join(app: ClientApp, target: string, room: string) {
    return this.control('rooms.join', app, target, room);
  }

  leave(app: ClientApp, target: string, room: string) {
    return this.control('rooms.leave', app, target, room);
  }
}

/** Keeps pushes in memory (tests, tools). */
export class RecordingRealtime implements Realtime {
  readonly pushes: (Omit<PushInput, 'occurredAt' | 'eventId'> & { envelope: Envelope })[] = [];
  readonly rooms: { op: 'join' | 'leave'; app: ClientApp; target: string; room: string }[] = [];

  async push(input: PushInput) {
    this.pushes.push({ ...input, envelope: envelopeOf(input) });
  }

  async join(app: ClientApp, target: string, room: string) {
    this.rooms.push({ op: 'join', app, target, room });
  }

  async leave(app: ClientApp, target: string, room: string) {
    this.rooms.push({ op: 'leave', app, target, room });
  }

  /** Pushes of one event name, newest last. */
  of(event: string) {
    return this.pushes.filter((p) => p.event === event);
  }

  clear() {
    this.pushes.length = 0;
    this.rooms.length = 0;
  }
}
