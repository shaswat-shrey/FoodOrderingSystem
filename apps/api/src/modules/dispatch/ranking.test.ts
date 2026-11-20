import { describe, expect, it } from 'vitest';
import { dispatchStart, noPartnerDeadline, rank, score, type CandidateFeatures } from './ranking';

const base: CandidateFeatures = {
  partnerId: 'p',
  distanceM: 1000,
  etaMinutes: 4,
  minutesUntilReady: 10,
  idleMinutes: 20,
  acceptanceRate: 0.9,
  rating: 4.5,
  deliveriesToday: 5,
};

describe('dispatch ranking (DELIVERY-ASSIGNMENT-ALGORITHM §5)', () => {
  it('scores in [0, 1] with a stored breakdown', () => {
    const s = score(base);
    expect(s.score).toBeGreaterThan(0);
    expect(s.score).toBeLessThanOrEqual(1);
    expect(Object.keys(s.breakdown).sort()).toEqual([
      'acceptance',
      'eta',
      'idle',
      'load',
      'rating',
      'ready',
    ]);
    expect(s.score).toBeCloseTo(
      Object.values(s.breakdown).reduce((a, b) => a + b, 0),
      3,
    );
  });

  it('prefers the closer partner, and breaks ties by distance then id', () => {
    const far = { ...base, partnerId: 'far', distanceM: 4000, etaMinutes: 14 };
    const near = { ...base, partnerId: 'near' };
    expect(rank([far, near]).map((c) => c.partnerId)).toEqual(['near', 'far']);
    const twinA = { ...base, partnerId: 'b' };
    const twinB = { ...base, partnerId: 'a' };
    expect(rank([twinA, twinB]).map((c) => c.partnerId)).toEqual(['a', 'b']);
  });

  it('gives fairness weight to idle partners', () => {
    const busy = { ...base, partnerId: 'busy', idleMinutes: 0, deliveriesToday: 20 };
    const idle = { ...base, partnerId: 'idle', idleMinutes: 45, deliveriesToday: 2 };
    expect(rank([busy, idle])[0]!.partnerId).toBe('idle');
  });
});

describe('dispatch timing (FR-DISP-001, BR-DEL-003)', () => {
  const accepted = new Date('2026-11-21T07:30:00Z');
  it('starts right away for quick orders, otherwise ahead of the ready time', () => {
    expect(
      dispatchStart({
        acceptedAt: accepted,
        readyBy: new Date(accepted.getTime() + 12 * 60_000),
        prepMinutes: 12,
        travelMinutes: 8,
        leadBufferMinutes: 5,
      }),
    ).toEqual(accepted);
    expect(
      dispatchStart({
        acceptedAt: accepted,
        readyBy: new Date(accepted.getTime() + 30 * 60_000),
        prepMinutes: 30,
        travelMinutes: 8,
        leadBufferMinutes: 5,
      }),
    ).toEqual(new Date(accepted.getTime() + 17 * 60_000));
  });
  it('gives up 30 min after ready, never sooner than 45 min after acceptance', () => {
    expect(
      noPartnerDeadline({
        acceptedAt: accepted,
        readyBy: new Date(accepted.getTime() + 20 * 60_000),
        afterReadyMinutes: 30,
        afterAcceptMinutes: 45,
      }),
    ).toEqual(new Date(accepted.getTime() + 50 * 60_000));
    expect(
      noPartnerDeadline({
        acceptedAt: accepted,
        readyBy: null,
        afterReadyMinutes: 30,
        afterAcceptMinutes: 45,
      }),
    ).toEqual(new Date(accepted.getTime() + 45 * 60_000));
  });
});
