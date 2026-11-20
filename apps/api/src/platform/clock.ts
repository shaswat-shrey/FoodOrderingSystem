/** Injectable time source so expiry, lockout and TTL rules are testable without sleeping. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Test clock that only moves when told to. */
export class ManualClock implements Clock {
  constructor(private current = new Date('2026-11-20T10:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = new Date(date);
  }
}
