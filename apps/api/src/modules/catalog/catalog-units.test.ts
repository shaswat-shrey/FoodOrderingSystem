import { describe, expect, it } from 'vitest';
import { computeBranchStatus, type BranchStatusInput } from './branch-status';
import { deliveryFeeFor, etaRange, surgeFor, type FeeScheduleView } from './delivery-quote';
import { zonedInstant } from './local-time';

const IST = 'Asia/Kolkata';
/** 2026-11-20 is a Friday (weekday 5). */
const at = (hm: string, day = 20) => {
  const [h, m] = hm.split(':').map(Number);
  return zonedInstant(2026, 11, day, h! * 60 + m!, IST);
};
const everyDay = (opens: string, closes: string) =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensAt: opens, closesAt: closes }));

function input(over: Partial<BranchStatusInput> & { now: Date }): BranchStatusInput {
  return {
    timezone: IST,
    restaurant: { status: 'ACTIVE', onboardingStatus: 'APPROVED', fssaiExpiresOn: null },
    branch: {
      status: 'ACTIVE',
      deletedAt: null,
      isOpenManual: true,
      pausedUntil: null,
      defaultPrepMinutes: 20,
    },
    zoneStatus: 'ACTIVE',
    hours: everyDay('11:00', '23:00'),
    holidays: [],
    ...over,
  };
}

describe('branch status (BR-REST-001, BR-REST-004, FR-MENUC-001)', () => {
  it('is open inside a slot and closing soon within 30 minutes of the last-order time', () => {
    expect(computeBranchStatus(input({ now: at('13:00') }))).toMatchObject({
      state: 'OPEN',
      acceptingOrders: true,
      lastOrderAt: at('22:40'), // 23:00 − 20 min prep
    });
    expect(computeBranchStatus(input({ now: at('22:15') })).state).toBe('CLOSING_SOON');
  });

  it('stops orders at the last-order cutoff (at least 15 minutes before close)', () => {
    const status = computeBranchStatus(input({ now: at('22:45') }));
    expect(status).toMatchObject({
      state: 'CLOSED',
      reason: 'LAST_ORDER_CUTOFF',
      acceptingOrders: false,
    });
    expect(status.opensAt).toEqual(at('11:00', 21));
    const fastKitchen = input({ now: at('22:46') });
    fastKitchen.branch.defaultPrepMinutes = 5;
    expect(computeBranchStatus(fastKitchen).reason).toBe('LAST_ORDER_CUTOFF'); // 15-minute floor
  });

  it('handles slots that cross midnight, including the part after midnight', () => {
    const late = input({ now: at('01:00', 21), hours: everyDay('18:00', '02:00') });
    expect(computeBranchStatus(late)).toMatchObject({
      state: 'OPEN',
      lastOrderAt: at('01:40', 21),
    });
    expect(computeBranchStatus({ ...late, now: at('01:15', 21) }).state).toBe('CLOSING_SOON');
    const morning = computeBranchStatus(
      input({ now: at('09:00'), hours: everyDay('18:00', '02:00') }),
    );
    expect(morning).toMatchObject({ reason: 'OUTSIDE_HOURS', opensAt: at('18:00') });
  });

  it('supports split shifts and weekday-specific hours', () => {
    const hours = [
      { weekday: 5, opensAt: '08:00', closesAt: '11:00' },
      { weekday: 5, opensAt: '17:00', closesAt: '22:00' },
      { weekday: 6, opensAt: '10:00', closesAt: '14:00' },
    ];
    expect(computeBranchStatus(input({ now: at('14:00'), hours }))).toMatchObject({
      reason: 'OUTSIDE_HOURS',
      opensAt: at('17:00'),
    });
    expect(computeBranchStatus(input({ now: at('23:00'), hours })).opensAt).toEqual(
      at('10:00', 21),
    );
  });

  it('closes for holidays, and a holiday starting later ends the current slot early', () => {
    const holiday = { startsAt: at('15:00'), endsAt: at('18:00') };
    expect(computeBranchStatus(input({ now: at('16:00'), holidays: [holiday] }))).toMatchObject({
      reason: 'HOLIDAY',
      opensAt: at('18:00'),
    });
    expect(
      computeBranchStatus(input({ now: at('12:00'), holidays: [holiday] })).lastOrderAt,
    ).toEqual(at('14:40'));
  });

  it('reports pause, manual close, FSSAI expiry, zone suspension and unlisted branches', () => {
    const paused = input({ now: at('13:00') });
    paused.branch.pausedUntil = at('13:30');
    expect(computeBranchStatus(paused)).toMatchObject({
      state: 'PAUSED',
      reason: 'PAUSED',
      opensAt: at('13:30'),
    });

    const manual = input({ now: at('13:00') });
    manual.branch.isOpenManual = false;
    expect(computeBranchStatus(manual)).toMatchObject({
      state: 'CLOSED',
      reason: 'MANUALLY_CLOSED',
      opensAt: null,
    });

    const fssai = input({ now: at('13:00') });
    fssai.restaurant.fssaiExpiresOn = new Date(Date.UTC(2026, 10, 19));
    expect(computeBranchStatus(fssai)).toMatchObject({ state: 'PAUSED', reason: 'FSSAI_EXPIRED' });
    fssai.restaurant.fssaiExpiresOn = new Date(Date.UTC(2026, 10, 20)); // valid through today
    expect(computeBranchStatus(fssai).acceptingOrders).toBe(true);

    expect(computeBranchStatus(input({ now: at('13:00'), zoneStatus: 'SUSPENDED' })).reason).toBe(
      'ZONE_SUSPENDED',
    );

    const pending = input({ now: at('13:00') });
    pending.restaurant.onboardingStatus = 'UNDER_REVIEW';
    expect(computeBranchStatus(pending)).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'NOT_LISTED',
    });
  });

  it('accepts Prisma TIME values for hours', () => {
    const hours = [5].map((weekday) => ({
      weekday,
      opensAt: new Date('1970-01-01T11:00:00Z'),
      closesAt: new Date('1970-01-01T23:00:00Z'),
    }));
    expect(computeBranchStatus(input({ now: at('12:00'), hours })).acceptingOrders).toBe(true);
  });
});

const schedule: FeeScheduleView = {
  id: 'fs',
  slabs: [
    { fromM: 0, toM: 2000, feeAmount: 1900 },
    { fromM: 2000, toM: 4000, feeAmount: 2900 },
    { fromM: 4000, toM: 6000, feeAmount: 3900 },
    { fromM: 6000, toM: 8000, feeAmount: 4900 },
  ],
  perKmBeyondSlabsAmount: 800,
  smallOrderThresholdAmount: 14900,
  smallOrderFeeAmount: 1500,
  platformFeeAmount: 500,
  surgeCapAmount: 4000,
  packagingCapPerItemAmount: 1000,
  packagingCapPerOrderAmount: 5000,
};

describe('delivery quote (BR-PRICE-003, BR-PRICE-007, FR-DISC-010)', () => {
  it.each([
    [0, 1900],
    [1999, 1900],
    [2000, 2900],
    [7999, 4900],
    [8000, 4900],
    [8001, 5700],
    [10_500, 7300], // 3 started km beyond 8 km
  ])('%i m costs %i paise', (distance, fee) => {
    expect(deliveryFeeFor(distance, schedule)).toBe(fee);
  });

  it('applies surge only while active and caps it', () => {
    const now = new Date('2026-11-20T10:00:00Z');
    const zone = {
      surgeAmount: 6000,
      surgeReason: 'Rain',
      surgeUntil: new Date('2026-11-20T11:00:00Z'),
    };
    expect(surgeFor(zone, 4000, now)).toEqual({ amount: 4000, reason: 'Rain' });
    expect(surgeFor({ ...zone, surgeUntil: now }, 4000, now).amount).toBe(0);
  });

  it('rounds ETA to 5 minutes with a ± range', () => {
    expect(
      etaRange({
        prepMinutes: 20,
        rushExtraMinutes: 0,
        travelSeconds: 600,
        bufferMinutes: 5,
        rangeMinutes: 5,
      }),
    ).toEqual({
      minMinutes: 30,
      maxMinutes: 40,
    });
    expect(
      etaRange({
        prepMinutes: 1,
        rushExtraMinutes: 0,
        travelSeconds: 0,
        bufferMinutes: 0,
        rangeMinutes: 5,
      }).minMinutes,
    ).toBe(5);
  });
});
