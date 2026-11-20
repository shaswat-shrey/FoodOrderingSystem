import { describe, expect, it, vi } from 'vitest';
import { evaluateReadiness } from './readiness';

describe('evaluateReadiness', () => {
  it('times out hanging checks instead of hanging the probe', async () => {
    vi.useFakeTimers();
    const pending = evaluateReadiness({ critical: { database: () => new Promise(() => {}) }, degradable: {} });
    await vi.advanceTimersByTimeAsync(2001);
    const report = await pending;
    vi.useRealTimers();
    expect(report.status).toBe('unavailable');
    expect(report.checks.database?.error).toBe('timeout');
  });
});
