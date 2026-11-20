import { describe, expect, it } from 'vitest';
import { cancellationPay, payTotal, tripPay } from './pay';

const plan = {
  baseAmount: 2500,
  perKmAmount: 600,
  freeKmM: 2000,
  waitAfterMinutes: 10,
  perWaitMinuteAmount: 100,
  waitCapAmount: 3000,
  rainBonusAmount: 2000,
  cancellationMinAmount: 1500,
};

describe('partner pay (BR-EARN-001, 007)', () => {
  it('pays base, distance beyond 2 km, waiting beyond 10 min (capped) and surge', () => {
    expect(tripPay(plan, { dropRoadM: 1500, waitMinutes: 5, surge: false })).toEqual({
      base: 2500,
      distance: 0,
      wait: 0,
      surge: 0,
    });
    const p = tripPay(plan, { dropRoadM: 5500, waitMinutes: 14.5, surge: true });
    expect(p).toEqual({ base: 2500, distance: 2100, wait: 400, surge: 2000 });
    expect(payTotal(p)).toBe(7000);
    expect(tripPay(plan, { dropRoadM: 0, waitMinutes: 90, surge: false }).wait).toBe(3000);
  });

  it('compensates cancelled trips', () => {
    expect(
      payTotal(
        cancellationPay(plan, {
          stage: 'BEFORE_PICKUP',
          travelledM: 1200,
          trip: { dropRoadM: 4000, waitMinutes: 0, surge: false },
        }),
      ),
    ).toBe(2500 + 720);
    expect(
      payTotal(
        cancellationPay(
          { ...plan, baseAmount: 500 },
          {
            stage: 'BEFORE_PICKUP',
            travelledM: 0,
            trip: { dropRoadM: 0, waitMinutes: 0, surge: false },
          },
        ),
      ),
    ).toBe(1500);
    expect(
      payTotal(
        cancellationPay(plan, {
          stage: 'AFTER_PICKUP',
          travelledM: 0,
          trip: { dropRoadM: 4000, waitMinutes: 0, surge: false },
        }),
      ),
    ).toBe(2500 + 1200);
  });
});
