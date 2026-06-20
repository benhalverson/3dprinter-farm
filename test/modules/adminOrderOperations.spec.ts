import { describe, expect, test } from 'vitest';
import {
  type AdminOrderDetail,
  type AdminOrderEvent,
  type AdminOrderListFilters,
  type AdminOrderListItem,
  type AdminOrderReadAdapter,
  type AdminOrderWriteAdapter,
  createAdminOrderOperations,
} from '../../src/modules/adminOrderOperations';

type OrderRecord = Omit<AdminOrderDetail, 'events'>;

const FIXED_TIME = '2026-06-19T12:00:00.000Z';

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 1,
    orderNumber: 'ORD-001',
    userId: 'user_1',
    filename: 'test.stl',
    fileURL: 'https://example.com/test.stl',
    status: 'pending',
    slantStatus: null,
    slantPublicOrderId: null,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    customerEmail: 'customer@example.com',
    shipToName: 'John Doe',
    shipToStreet1: '123 Main St',
    shipToStreet2: null,
    shipToCity: 'Anytown',
    shipToState: 'CA',
    shipToZip: '90210',
    shipToCountryISO: 'US',
    billToStreet1: null,
    billToStreet2: null,
    billToCity: null,
    billToState: null,
    billToZip: null,
    billToCountryISO: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<AdminOrderEvent> = {}): AdminOrderEvent {
  return {
    id: 1,
    orderId: 1,
    type: 'order_created',
    detail: 'Order placed',
    actor: 'system',
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function projectListItem(order: OrderRecord): AdminOrderListItem {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    userId: order.userId,
    status: order.status,
    slantStatus: order.slantStatus,
    slantPublicOrderId: order.slantPublicOrderId,
    customerEmail: order.customerEmail,
    createdAt: order.createdAt,
  };
}

function matchesFilters(
  order: OrderRecord,
  filters: AdminOrderListFilters = {},
) {
  if (filters.status && order.status !== filters.status) return false;
  if (filters.slantStatus && order.slantStatus !== filters.slantStatus) {
    return false;
  }
  if (filters.email && order.customerEmail !== filters.email) return false;
  if (filters.orderNumber && order.orderNumber !== filters.orderNumber) {
    return false;
  }
  if (
    filters.slantPublicOrderId &&
    order.slantPublicOrderId !== filters.slantPublicOrderId
  ) {
    return false;
  }
  if (
    filters.stripeCheckoutSessionId &&
    order.stripeCheckoutSessionId !== filters.stripeCheckoutSessionId
  ) {
    return false;
  }
  if (
    filters.stripePaymentIntentId &&
    order.stripePaymentIntentId !== filters.stripePaymentIntentId
  ) {
    return false;
  }
  if (
    filters.createdAfter &&
    (!order.createdAt || order.createdAt < filters.createdAfter)
  ) {
    return false;
  }
  if (
    filters.createdBefore &&
    (!order.createdAt || order.createdAt > filters.createdBefore)
  ) {
    return false;
  }
  if (
    filters.q &&
    !order.orderNumber.includes(filters.q) &&
    !order.customerEmail?.includes(filters.q)
  ) {
    return false;
  }

  return true;
}

function makeStore({
  orders = [],
  events = [],
}: {
  orders?: OrderRecord[];
  events?: AdminOrderEvent[];
}) {
  const orderRecords = new Map(orders.map(order => [order.id, { ...order }]));
  const eventRecords = events.map(event => ({ ...event }));
  let nextEventId =
    eventRecords.reduce((max, event) => Math.max(max, event.id), 0) + 1;

  function appendEvent(event: Omit<AdminOrderEvent, 'id'>) {
    const created = { id: nextEventId++, ...event };
    eventRecords.push(created);
    return created;
  }

  const read: AdminOrderReadAdapter = {
    async list(filters) {
      return Array.from(orderRecords.values())
        .filter(order => matchesFilters(order, filters))
        .map(projectListItem);
    },

    async getDetail(orderId) {
      const order = orderRecords.get(orderId);

      if (!order) {
        return null;
      }

      return {
        ...order,
        events: eventRecords.filter(event => event.orderId === orderId),
      };
    },

    async getLifecycle(orderId) {
      const order = orderRecords.get(orderId);

      if (!order) {
        return null;
      }

      return {
        id: order.id,
        status: order.status,
        slantStatus: order.slantStatus,
      };
    },
  };

  const write: AdminOrderWriteAdapter = {
    async markRetryingAndAppendEvent({ orderId, actor, detail, at }) {
      const order = orderRecords.get(orderId);

      if (!order) {
        throw new Error(`Missing order ${orderId}`);
      }

      order.status = 'retrying';
      order.updatedAt = at;

      return appendEvent({
        orderId,
        type: 'retry_initiated',
        detail,
        actor,
        createdAt: at,
      });
    },

    async appendEvent({ orderId, type, actor, detail, at }) {
      if (!orderRecords.has(orderId)) {
        throw new Error(`Missing order ${orderId}`);
      }

      return appendEvent({
        orderId,
        type,
        detail,
        actor,
        createdAt: at,
      });
    },
  };

  return {
    read,
    write,
    order: (orderId: number) => orderRecords.get(orderId),
    eventsFor: (orderId: number) =>
      eventRecords.filter(event => event.orderId === orderId),
  };
}

function makeOperations(store: ReturnType<typeof makeStore>) {
  return createAdminOrderOperations({
    read: store.read,
    write: store.write,
    clock: () => FIXED_TIME,
  });
}

describe('AdminOrderOperations', () => {
  test('lists orders with supported filters and search', async () => {
    const store = makeStore({
      orders: [
        makeOrder({
          id: 1,
          orderNumber: 'ORD-001',
          status: 'failed',
          slantStatus: 'error',
          slantPublicOrderId: 'slant_1',
          stripeCheckoutSessionId: 'cs_1',
          stripePaymentIntentId: 'pi_1',
          customerEmail: 'customer@example.com',
          createdAt: '2024-06-01T00:00:00Z',
        }),
        makeOrder({
          id: 2,
          orderNumber: 'ORD-002',
          status: 'pending',
          slantStatus: null,
          slantPublicOrderId: 'slant_2',
          stripeCheckoutSessionId: 'cs_2',
          stripePaymentIntentId: 'pi_2',
          customerEmail: 'other@example.com',
          createdAt: '2024-07-01T00:00:00Z',
        }),
      ],
    });

    const result = await makeOperations(store).list({
      status: 'failed',
      slantStatus: 'error',
      email: 'customer@example.com',
      orderNumber: 'ORD-001',
      slantPublicOrderId: 'slant_1',
      stripeCheckoutSessionId: 'cs_1',
      stripePaymentIntentId: 'pi_1',
      createdAfter: '2024-01-01',
      createdBefore: '2024-12-31',
      q: 'customer',
    });

    expect(result.orders).toEqual([
      {
        id: 1,
        orderNumber: 'ORD-001',
        userId: 'user_1',
        status: 'failed',
        slantStatus: 'error',
        slantPublicOrderId: 'slant_1',
        customerEmail: 'customer@example.com',
        createdAt: '2024-06-01T00:00:00Z',
      },
    ]);
  });

  test('gets order detail with events', async () => {
    const store = makeStore({
      orders: [makeOrder({ id: 1 })],
      events: [makeEvent({ id: 1, orderId: 1 })],
    });

    const detail = await makeOperations(store).getDetail(1);

    expect(detail?.orderNumber).toBe('ORD-001');
    expect(detail?.events).toEqual([makeEvent({ id: 1, orderId: 1 })]);
  });

  test('returns null for missing order detail', async () => {
    const store = makeStore({ orders: [] });

    await expect(makeOperations(store).getDetail(999)).resolves.toBeNull();
  });

  test.each([
    'failed',
    'error',
    'pending',
  ])('starts retry for %s orders', async status => {
    const store = makeStore({
      orders: [makeOrder({ id: 1, status, slantStatus: null })],
    });

    const result = await makeOperations(store).requestRetry({
      orderId: 1,
      actor: { email: 'admin@example.com' },
    });

    expect(result.type).toBe('retry_started');
    expect(store.order(1)?.status).toBe('retrying');
    expect(store.order(1)?.updatedAt).toBe(FIXED_TIME);
    expect(store.eventsFor(1)).toMatchObject([
      {
        type: 'retry_initiated',
        detail: 'Admin retry initiated by admin@example.com',
        actor: 'admin@example.com',
        createdAt: FIXED_TIME,
      },
    ]);
  });

  test('rejects retry for already processed Slant orders', async () => {
    const store = makeStore({
      orders: [
        makeOrder({ id: 1, status: 'completed', slantStatus: 'fulfilled' }),
      ],
    });

    const result = await makeOperations(store).requestRetry({
      orderId: 1,
      actor: { email: 'admin@example.com' },
    });

    expect(result).toEqual({
      type: 'retry_rejected',
      reason: 'already_processed',
      message: 'Order already successfully processed. Retry is not allowed.',
    });
    expect(store.eventsFor(1)).toEqual([]);
  });

  test('rejects retry for non-eligible order status', async () => {
    const store = makeStore({
      orders: [makeOrder({ id: 1, status: 'shipped', slantStatus: null })],
    });

    const result = await makeOperations(store).requestRetry({
      orderId: 1,
      actor: { email: 'admin@example.com' },
    });

    expect(result).toEqual({
      type: 'retry_rejected',
      reason: 'status_not_eligible',
      message: 'Order status "shipped" is not eligible for retry.',
    });
    expect(store.eventsFor(1)).toEqual([]);
  });

  test('returns not_found when retry target is missing', async () => {
    const store = makeStore({ orders: [] });

    const result = await makeOperations(store).requestRetry({
      orderId: 999,
      actor: { email: 'admin@example.com' },
    });

    expect(result).toEqual({ type: 'not_found' });
  });

  test('records notification resend event', async () => {
    const store = makeStore({
      orders: [makeOrder({ id: 1, status: 'pending' })],
    });

    const result = await makeOperations(store).recordNotificationResend({
      orderId: 1,
      actor: { email: 'admin@example.com' },
    });

    expect(result.type).toBe('notification_resend_recorded');
    expect(store.eventsFor(1)).toMatchObject([
      {
        type: 'notification_resent',
        detail: 'Notification resent by admin@example.com',
        actor: 'admin@example.com',
        createdAt: FIXED_TIME,
      },
    ]);
  });

  test('uses unknown-admin actor fallback', async () => {
    const store = makeStore({
      orders: [makeOrder({ id: 1, status: 'pending' })],
    });

    await makeOperations(store).recordNotificationResend({
      orderId: 1,
      actor: {},
    });

    expect(store.eventsFor(1)).toMatchObject([
      {
        type: 'notification_resent',
        detail: 'Notification resent by unknown-admin',
        actor: 'unknown-admin',
      },
    ]);
  });
});
