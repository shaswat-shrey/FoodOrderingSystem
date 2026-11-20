import type { BranchRecord } from './branch-repository';
import { formatHm, localParts, toMinutes } from './local-time';
import type { DeliveryInfo } from './serviceability.service';

/** BR-REVIEW-007 prior: mean 4.0 with weight 10; "New" until 10 ratings. */
const PRIOR_MEAN = 4;
const PRIOR_WEIGHT = 10;

/** `ratingAvgBps` is the raw average in hundredths of a star (4.35★ = 435). */
export function ratingView(avgBps: number | null, count: number) {
  if (!avgBps || count === 0) return { average: null, count: 0, isNew: true };
  const raw = avgBps / 100;
  const bayes = (count * raw + PRIOR_WEIGHT * PRIOR_MEAN) / (count + PRIOR_WEIGHT);
  return { average: Math.round(bayes * 10) / 10, count, isNew: count < PRIOR_WEIGHT };
}

export function statusView(b: BranchRecord) {
  return {
    state: b.computed.state,
    acceptingOrders: b.computed.acceptingOrders,
    reason: b.computed.reason,
    opensAt: b.computed.opensAt,
    lastOrderAt: b.computed.lastOrderAt,
  };
}

export function deliveryView(info: DeliveryInfo) {
  return {
    serviceable: info.serviceable,
    reason: info.reason,
    distanceKm: info.distanceKm,
    eta: info.eta,
    deliveryFeeAmount: info.deliveryFeeAmount,
    surge: info.surge,
  };
}

/** Listing card (FR-DISC-001 step 4). Offers join in Phase 6. */
export function branchCard(
  b: BranchRecord,
  extra: { delivery?: DeliveryInfo | null; isFavorite?: boolean } = {},
) {
  return {
    branchId: b.id,
    restaurantId: b.restaurant.id,
    restaurantName: b.restaurant.brandName,
    branchName: b.name,
    slug: b.restaurant.slug,
    area: b.area,
    logoUrl: null as string | null,
    coverUrl: null as string | null,
    cuisines: b.restaurant.cuisines.slice(0, 3).map((c) => c.cuisine.name),
    rating: ratingView(
      b.ratingAvgBps ?? b.restaurant.ratingAvgBps,
      b.ratingAvgBps ? b.ratingCount : b.restaurant.ratingCount,
    ),
    priceForTwoAmount: b.priceForTwo,
    pureVeg: b.restaurant.pureVeg,
    status: statusView(b),
    delivery: extra.delivery ? deliveryView(extra.delivery) : null,
    bestOffer: null as string | null,
    isFavorite: extra.isFavorite ?? false,
  };
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** API-REST-004: weekly slots (weekday 0 = Sunday) and holidays within the next week. */
export function hoursView(b: BranchRecord, now: Date) {
  const week = WEEKDAY_NAMES.map((name, weekday) => ({
    weekday,
    name,
    slots: b.operatingHours
      .filter((h) => h.weekday === weekday)
      .map((h) => ({ opens: toMinutes(h.opensAt), closes: toMinutes(h.closesAt) }))
      .sort((x, y) => x.opens - y.opens)
      .map((s) => ({ opensAt: formatHm(s.opens), closesAt: formatHm(s.closes) })),
  }));
  const today = localParts(now, b.timezone).weekday;
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
  return {
    timezone: b.timezone,
    today: week[today]!,
    week,
    upcomingHolidays: b.holidays
      .filter((h) => h.startsAt < weekAhead)
      .map((h) => ({ startsAt: h.startsAt, endsAt: h.endsAt, reason: h.reason })),
  };
}

/** API-REST-003 / FR-MENUC-001 header. */
export function branchPage(
  b: BranchRecord,
  now: Date,
  extra: { delivery?: DeliveryInfo | null; isFavorite?: boolean } = {},
) {
  return {
    ...branchCard(b, extra),
    description: b.restaurant.description,
    address: {
      line1: b.line1,
      line2: b.line2,
      area: b.area,
      city: b.city,
      state: b.state,
      pincode: b.pincode,
    },
    location: b.point,
    fssaiNumber: b.restaurant.fssaiNumber, // BR-REST-010
    minOrderAmount: b.minOrderAmount,
    maxOrderAmount: b.maxOrderAmount,
    hours: hoursView(b, now),
    offers: [] as unknown[], // promotions and coupons arrive in Phase 6
    deliveryDetails: extra.delivery ?? null,
  };
}
