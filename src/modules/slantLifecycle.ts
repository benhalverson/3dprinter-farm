import { and, eq, exists, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from '../db/schema';
import {
  orderEventsTable as events,
  ordersTable as orders,
} from '../db/schema';

type Database = DrizzleD1Database<typeof schema>;
export type SlantStatus =
  | 'DRAFT'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELED';
const successors: Record<SlantStatus, SlantStatus[]> = {
  DRAFT: ['DRAFT', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELED'],
  PROCESSING: ['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELED'],
  SHIPPED: ['SHIPPED', 'DELIVERED'],
  DELIVERED: ['DELIVERED'],
  CANCELED: ['CANCELED'],
};

/** Scope trusted webhook evidence independently of historical or Square event IDs. */
export function slantEventKey(
  orderId: number,
  publicId: string,
  eventId: string,
) {
  return JSON.stringify(['slant-authenticated-v1', orderId, publicId, eventId]);
}

/** Recognize only server-generated evidence from the atomic authenticated producer. */
export function isTrustedSlantEvent(
  event: typeof events.$inferSelect,
  order: typeof orders.$inferSelect,
) {
  if (
    !order.slantPublicOrderId ||
    !event.externalEventId ||
    event.source !== 'slant3d' ||
    event.actor !== 'slant3d' ||
    event.type !== 'slant_status_changed'
  )
    return false;
  let metadata: { provenance?: string; slantOrderId?: string };
  try {
    metadata = JSON.parse(event.metadata ?? 'null');
  } catch {
    return false;
  }
  if (
    metadata?.provenance !== 'configured-secret-v1' ||
    metadata.slantOrderId !== order.slantPublicOrderId
  )
    return false;
  return (
    event.dedupeKey ===
    slantEventKey(order.id, order.slantPublicOrderId, event.externalEventId)
  );
}

/** Preserve bounded customer tracking fields without admitting caller authority fields. */
function trackingMetadata(metadata?: Record<string, unknown>) {
  const result: Record<string, string> = {};
  for (const key of [
    'trackingNumber',
    'tracking_number',
    'trackingUrl',
    'tracking_url',
    'carrier',
    'estimatedArrival',
    'estimated_arrival',
  ]) {
    const value = metadata?.[key];
    if (
      typeof value === 'string' &&
      value.length <= 2048 &&
      !/[\r\n]/.test(value)
    )
      result[key] = value;
  }
  return result;
}

/**
 * Persist authenticated manufacturing evidence and its state transition atomically.
 * A pending event cannot authorize email; only the batch that wins the order CAS
 * promotes it. Payment/refund fields are intentionally not lifecycle state.
 */
export async function recordSlantLifecycle(
  db: Database,
  input: {
    eventId: string;
    orderId: string;
    status: SlantStatus;
    metadata?: Record<string, unknown>;
  },
) {
  const matches = await db
    .select()
    .from(orders)
    .where(eq(orders.slantPublicOrderId, input.orderId))
    .limit(2);
  if (matches.length !== 1)
    return {
      status: matches.length ? 409 : 404,
      error: matches.length ? 'Ambiguous order identity' : 'Order not found',
    } as const;
  const order = matches[0];
  const key = slantEventKey(order.id, input.orderId, input.eventId);
  const existing = await db
    .select()
    .from(events)
    .where(eq(events.dedupeKey, key))
    .get();
  if (
    existing &&
    (existing.nextStatus !== input.status ||
      existing.orderId !== order.id ||
      existing.externalEventId !== input.eventId ||
      existing.source !== 'slant3d' ||
      existing.actor !== 'slant3d')
  )
    return { status: 409, error: 'Conflicting event identity' } as const;
  if (existing && isTrustedSlantEvent(existing, order))
    return {
      status: 200,
      orderId: order.id,
      lifecycleStatus: input.status,
    } as const;
  const prior =
    order.slantStatus?.toUpperCase() ??
    (['drafted', 'processing', 'process_unknown'].includes(
      order.fulfillmentState ?? '',
    )
      ? 'DRAFT'
      : null);
  if (!prior || !successors[prior as SlantStatus]?.includes(input.status))
    return { status: 409, error: 'Invalid lifecycle transition' } as const;
  const predecessor = and(
    eq(orders.id, order.id),
    eq(orders.slantPublicOrderId, input.orderId),
    order.slantStatus === null
      ? isNull(orders.slantStatus)
      : eq(orders.slantStatus, order.slantStatus),
    order.fulfillmentState === null
      ? isNull(orders.fulfillmentState)
      : eq(orders.fulfillmentState, order.fulfillmentState),
    order.status === null
      ? isNull(orders.status)
      : eq(orders.status, order.status),
    order.slantEventKey === null
      ? isNull(orders.slantEventKey)
      : eq(orders.slantEventKey, order.slantEventKey),
  );
  const now = new Date().toISOString();
  const fields: Partial<typeof orders.$inferInsert> = {
    status: input.status.toLowerCase(),
    slantStatus: input.status,
    slantEventKey: key,
    updatedAt: now,
  };
  // Advanced authenticated lifecycle wins against in-flight fulfillment writers,
  // whose claims require drafting/processing/unknown states. Cancellation also
  // makes every future manufacturing retry ineligible.
  if (input.status === 'CANCELED') fields.fulfillmentState = 'canceled';
  else if (input.status !== 'DRAFT') fields.fulfillmentState = 'processed';
  if (input.status !== prior) {
    if (input.status === 'PROCESSING') fields.processedAt = now;
    if (input.status === 'SHIPPED') fields.shippedAt = now;
    if (input.status === 'DELIVERED') fields.deliveredAt = now;
    if (input.status === 'CANCELED') fields.canceledAt = now;
  }
  await db.batch([
    db
      .insert(events)
      .values({
        orderId: order.id,
        type: 'slant_status_pending',
        dedupeKey: key,
        source: 'slant3d',
        actor: 'slant3d',
        externalEventId: input.eventId,
        previousStatus: order.slantStatus,
        nextStatus: input.status,
        metadata: JSON.stringify({
          provenance: 'configured-secret-v1',
          slantOrderId: input.orderId,
          ...trackingMetadata(input.metadata),
        }),
        createdAt: now,
      })
      .onConflictDoNothing({ target: events.dedupeKey }),
    db
      .update(orders)
      .set(fields)
      .where(
        and(
          predecessor,
          exists(
            db
              .select({ id: events.id })
              .from(events)
              .where(
                and(
                  eq(events.dedupeKey, key),
                  eq(events.type, 'slant_status_pending'),
                  eq(events.nextStatus, input.status),
                  eq(events.orderId, order.id),
                  eq(events.source, 'slant3d'),
                  eq(events.actor, 'slant3d'),
                ),
              ),
          ),
        ),
      ),
    db
      .update(events)
      .set({ type: 'slant_status_changed', previousStatus: order.slantStatus })
      .where(
        and(
          eq(events.dedupeKey, key),
          eq(events.type, 'slant_status_pending'),
          exists(
            db
              .select({ id: orders.id })
              .from(orders)
              .where(
                and(
                  eq(orders.id, order.id),
                  eq(orders.slantEventKey, key),
                  eq(orders.slantStatus, input.status),
                  eq(orders.slantPublicOrderId, input.orderId),
                ),
              ),
          ),
        ),
      ),
  ]);
  const accepted = await db
    .select()
    .from(events)
    .where(eq(events.dedupeKey, key))
    .get();
  if (
    !accepted ||
    accepted.nextStatus !== input.status ||
    !isTrustedSlantEvent(accepted, order)
  )
    return { status: 409, error: 'Lifecycle changed; retry event' } as const;
  return {
    status: 200,
    orderId: order.id,
    lifecycleStatus: input.status,
  } as const;
}
