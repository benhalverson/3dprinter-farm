import type { ordersTable, orderEventsTable } from '../db/schema';
type OrderRow = typeof ordersTable.$inferSelect;
type OrderEventRow = typeof orderEventsTable.$inferSelect;
function parseJsonObject(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function safeOrderItems(value: string | null | undefined) {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) return [];

  return parsed.map(item => {
    const record = item as Record<string, unknown>;
    return {
      skuNumber: typeof record.skuNumber === 'string' ? record.skuNumber : null,
      name: typeof record.name === 'string' ? record.name : null,
      quantity: typeof record.quantity === 'number' ? record.quantity : 0,
      color: typeof record.color === 'string' ? record.color : null,
      filamentType:
        typeof record.filamentType === 'string' ? record.filamentType : null,
      image: typeof record.image === 'string' ? record.image : null,
      price:
        typeof record.unitAmountCents === 'number'
          ? record.unitAmountCents / 100
          : typeof record.price === 'number'
            ? record.price
            : null,
    };
  });
}

function trackingFromEvents(events: OrderEventRow[]) {
  for (const event of [...events].reverse()) {
    const metadata = parseJsonObject(event.metadata);
    if (!metadata) continue;

    const record = metadata as Record<string, unknown>;
    const trackingNumber =
      typeof record.trackingNumber === 'string'
        ? record.trackingNumber
        : typeof record.tracking_number === 'string'
          ? record.tracking_number
          : null;
    const trackingUrl =
      typeof record.trackingUrl === 'string'
        ? record.trackingUrl
        : typeof record.tracking_url === 'string'
          ? record.tracking_url
          : null;
    const carrier = typeof record.carrier === 'string' ? record.carrier : null;
    const estimatedArrival =
      typeof record.estimatedArrival === 'string'
        ? record.estimatedArrival
        : typeof record.estimated_arrival === 'string'
          ? record.estimated_arrival
          : null;

    if (trackingNumber || trackingUrl || carrier || estimatedArrival) {
      return { trackingNumber, trackingUrl, carrier, estimatedArrival };
    }
  }

  return {
    trackingNumber: null,
    trackingUrl: null,
    carrier: null,
    estimatedArrival: null,
  };
}

export function toCustomerOrder(order: OrderRow, events: OrderEventRow[] = []) {
  const tracking = trackingFromEvents(events);

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    slantStatus: order.slantStatus,
    source: order.source,
    fulfillmentType: order.fulfillmentType,
    paymentStatus: order.paymentStatus,
    squareOrderId: order.squareOrderId,
    squarePaymentId: order.squarePaymentId,
    shippingAmountCents: order.shippingAmountCents,
    fulfillmentState: order.fulfillmentState,
    totalAmountCents: order.totalAmountCents,
    currency: order.currency,
    items: safeOrderItems(order.itemSnapshot),
    fulfillment: {
      slantPublicOrderId: order.slantPublicOrderId,
      trackingNumber: tracking.trackingNumber,
      trackingUrl: tracking.trackingUrl,
      carrier: tracking.carrier,
      estimatedArrival: tracking.estimatedArrival,
      shippedAt: order.shippedAt,
      deliveredAt: order.deliveredAt,
    },
    refund: order.refundStatus
      ? {
          status: order.refundStatus,
          amountCents: order.refundAmountCents,
          currency: order.currency,
          refundedAt: order.refundedAt,
        }
      : null,
    cancellation: order.canceledAt ? { canceledAt: order.canceledAt } : null,
  };
}
