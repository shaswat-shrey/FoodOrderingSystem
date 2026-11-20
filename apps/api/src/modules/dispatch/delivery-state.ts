import type { Delivery, DeliveryStatus, Prisma } from '@fos/db';
import { uuidv7 } from '@fos/shared';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import type { OrderActor } from '../orders';

type Tx = Prisma.TransactionClient;

/** SRS §12.1 delivery lifecycle (D01…D10). */
const ALLOWED: Record<DeliveryStatus, DeliveryStatus[]> = {
  PENDING: ['SEARCHING', 'CANCELLED'],
  SEARCHING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['SEARCHING', 'AT_RESTAURANT', 'EN_ROUTE_TO_CUSTOMER', 'CANCELLED'],
  AT_RESTAURANT: ['SEARCHING', 'EN_ROUTE_TO_CUSTOMER', 'CANCELLED'],
  EN_ROUTE_TO_CUSTOMER: ['AT_CUSTOMER', 'DELIVERED', 'FAILED'],
  AT_CUSTOMER: ['DELIVERED', 'FAILED'],
  DELIVERED: [],
  FAILED: [],
  CANCELLED: [],
};

const STAMP: Partial<Record<DeliveryStatus, keyof Delivery>> = {
  ASSIGNED: 'assignedAt',
  AT_RESTAURANT: 'arrivedRestaurantAt',
  EN_ROUTE_TO_CUSTOMER: 'pickedUpAt',
  AT_CUSTOMER: 'arrivedCustomerAt',
  DELIVERED: 'deliveredAt',
};

export async function lockDelivery(tx: Tx, id: string): Promise<Delivery> {
  await tx.$queryRaw`SELECT id FROM deliveries WHERE id = ${id}::uuid FOR UPDATE`;
  const d = await tx.delivery.findUnique({ where: { id } });
  if (!d) throw new AppError('NOT_FOUND', { message: "We couldn't find that delivery." });
  return d;
}

/** Moves a delivery, stamps the time, appends history (with where it happened) and an outbox event. */
export async function moveDelivery(
  tx: Tx,
  d: Delivery,
  to: DeliveryStatus,
  input: {
    actor: { type: OrderActor; id?: string | null };
    now: Date;
    patch?: Prisma.DeliveryUncheckedUpdateInput;
    at?: { lat: number; lng: number } | null;
    distanceToTargetM?: number | null;
    flagged?: boolean;
  },
): Promise<Delivery> {
  if (!ALLOWED[d.status].includes(to))
    throw new AppError('ORDER_STATE_CONFLICT', {
      message: `This delivery is ${d.status.toLowerCase().replace(/_/g, ' ')}.`,
    });
  const stamp = STAMP[to];
  const updated = await tx.delivery.update({
    where: { id: d.id },
    data: {
      ...(input.patch ?? {}),
      status: to,
      ...(stamp ? { [stamp]: input.now } : {}),
      version: { increment: 1 },
    },
  });
  await tx.$executeRaw`
    INSERT INTO delivery_status_history (id, delivery_id, from_status, to_status, actor_type, actor_id, location, distance_to_target_m, flagged, created_at)
    VALUES (${uuidv7()}::uuid, ${d.id}::uuid, ${d.status}::"DeliveryStatus", ${to}::"DeliveryStatus", ${input.actor.type}::"ActorType",
      ${input.actor.id ?? null}::uuid,
      ${input.at ? `POINT(${input.at.lng} ${input.at.lat})` : null}::text::geography,
      ${input.distanceToTargetM ?? null}, ${input.flagged ?? false}, ${input.now})`;
  await writeOutbox(tx, {
    aggregateType: 'delivery',
    aggregateId: d.id,
    aggregateVersion: updated.version,
    eventType: `delivery.${to.toLowerCase()}`,
    payload: {
      deliveryId: d.id,
      orderId: d.orderId,
      partnerId: updated.partnerId,
      // Set when a partner was released or the trip ended, so rooms and apps can follow.
      previousPartnerId: d.partnerId,
      from: d.status,
      to,
    },
  });
  return updated;
}
