import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { mockEnv } from '../mocks/env';
const state = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: 'seller',
  role: 'admin',
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => state.db }));
vi.mock('../../lib/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: async () =>
        state.userId
          ? { user: { id: state.userId, role: state.role }, session: {} }
          : null,
    },
  }),
}));
import sales from '../../src/routes/inPersonSales';
import payments from '../../src/routes/payments';
import admin from '../../src/routes/adminOrders';
let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const env = mockEnv();
const fetchMock = vi.fn<typeof fetch>();
let refundStatus = 'PENDING';
let phone = false;
let reference = '';
let amount = 1200;
let status = 'COMPLETED';
let location = 'location';
const requestKey = '12345678-1234-4123-8123-123456789abc';
function create(
  body: object = { requestKey, items: [{ productId: 1, quantity: 2 }] },
) {
  return sales.request(
    '/admin/in-person-sales',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}
async function event() {
  const body = JSON.stringify({
    type: 'payment.updated',
    merchant_id: 'merchant',
    data: { id: 'payment', type: 'payment' },
  });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('key'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(env.SQUARE_WEBHOOK_NOTIFICATION_URL + body),
    ),
  );
  return payments.request(
    '/webhook/square',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-square-hmacsha256-signature': btoa(String.fromCharCode(...signed)),
      },
      body,
    },
    env,
  );
}
beforeEach(async () => {
  refundStatus = 'PENDING';
  phone = false;
  state.userId = 'seller';
  state.role = 'admin';
  reference = '';
  amount = 1200;
  status = 'COMPLETED';
  location = 'location';
  client = createClient({ url: ':memory:' });
  db = drizzle(client, { schema });
  state.db = db;
  await migrate(db, { migrationsFolder: '.generated/quote-test-migrations' });
  await db.insert(schema.users).values({
    id: 'seller',
    name: 'Seller',
    email: 'seller@example.com',
    role: 'admin',
  });
  await db.insert(schema.productsTable).values({
    id: 1,
    name: 'Widget',
    description: 'Fixture',
    stl: 'file',
    price: 99,
    inPersonPrice: 600,
  });
  await db.insert(schema.organizationTable).values({
    id: 'org_shared_catalog',
    name: 'Staff',
    slug: 'staff',
    createdAt: new Date(),
  });
  await db.insert(schema.memberTable).values({
    id: 'staff',
    organizationId: 'org_shared_catalog',
    userId: 'seller',
    role: 'admin',
    createdAt: new Date(),
  });
  Object.assign(env, {
    SQUARE_ENVIRONMENT: 'sandbox',
    SQUARE_ACCESS_TOKEN: 'test',
    SQUARE_MERCHANT_ID: 'merchant',
    SQUARE_LOCATION_ID: 'location',
    SQUARE_WEBHOOK_SIGNATURE_KEY: 'key',
    SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://api.example/webhook/square',
    ORDER_NOTIFICATIONS_ENABLED: 'false',
  });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.includes('/refunds'))
      return Response.json({
        refund: {
          id: 'refund',
          payment_id: 'payment',
          location_id: 'location',
          status: refundStatus,
          amount_money: { amount: 1200, currency: 'USD' },
        },
      });
    if (path.includes('/locations/'))
      return Response.json({
        location: {
          id: 'location',
          merchant_id: 'merchant',
          currency: 'USD',
          status: 'ACTIVE',
        },
      });
    if (path.includes('/online-checkout/payment-links')) {
      const input = JSON.parse(String(init?.body));
      reference = input.order.reference_id;
      expect(input.idempotency_key).toBe(reference.slice(3));
      expect(input.order.line_items).toEqual([
        {
          name: 'Widget',
          quantity: '2',
          base_price_money: { amount: 600, currency: 'USD' },
        },
      ]);
      return Response.json({
        payment_link: {
          id: 'link',
          order_id: 'order',
          url: 'https://square.example/pay',
        },
      });
    }
    if (path.includes('/orders/'))
      return Response.json({
        order: {
          id: 'order',
          reference_id: reference,
          ...(phone
            ? {
                line_items: [
                  {
                    catalog_object_id: 'variation',
                    name: 'Sold Widget',
                    quantity: '2',
                    base_price_money: { amount: 600, currency: 'USD' },
                    total_money: { amount: 1200, currency: 'USD' },
                  },
                ],
              }
            : {}),
          location_id: 'location',
          total_money: { amount: 1200, currency: 'USD' },
        },
      });
    if (path.includes('/payments/'))
      return Response.json({
        payment: {
          id: 'payment',
          order_id: 'order',
          location_id: location,
          status,
          ...(phone
            ? { application_details: { square_product: 'SQUARE_POS' } }
            : {}),
          amount_money: { amount, currency: 'USD' },
          total_money: { amount, currency: 'USD' },
        },
      });
    throw new Error(`Unexpected provider call ${path}`);
  });
});
afterEach(() => {
  client.close();
  vi.unstubAllGlobals();
});
test('immutable QR sale retries, signed completion and admin reads preserve honest identity and prices', async () => {
  const created = await create();
  expect(created.status).toBe(201);
  const sale = await created.json();
  expect(sale).toMatchObject({
    totalCents: 1200,
    paymentStatus: 'pending',
    paymentUrl: 'https://square.example/pay',
  });
  await db
    .update(schema.productsTable)
    .set({ inPersonPrice: 900 })
    .where(eq(schema.productsTable.id, 1));
  expect(await (await create()).json()).toEqual(sale);
  expect(
    fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('payment-links'),
    ),
  ).toHaveLength(1);
  expect((await event()).status).toBe(200);
  expect((await event()).status).toBe(200);
  const orders = await db.select().from(schema.ordersTable);
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({
    userId: null,
    fileURL: null,
    shipToName: null,
    source: 'qr',
    fulfillmentType: 'in_person',
    status: 'handed_over',
    totalAmountCents: 1200,
    shippingAmountCents: 0,
  });
  expect(await db.select().from(schema.orderEventsTable)).toHaveLength(1);
  expect(
    await (
      await sales.request(`/admin/in-person-sales/${sale.saleId}`, {}, env)
    ).json(),
  ).toMatchObject({ paymentStatus: 'paid', paymentUrl: null });
  expect((await admin.request('/admin/orders', {}, env)).status).toBe(200);
  expect(
    await (
      await admin.request(`/admin/orders/${orders[0].id}`, {}, env)
    ).json(),
  ).toMatchObject({ source: 'qr', userId: null, totalAmountCents: 1200 });
  expect(
    fetchMock.mock.calls.every(([url]) =>
      /^https:\/\/connect\.(squareup|squareupsandbox)\.com\//.test(String(url)),
    ),
  ).toBe(true);
});
test('rejects authorization, injected totals, duplicate items and changed retry keys', async () => {
  state.userId = '';
  expect((await create()).status).toBe(401);
  state.userId = 'seller';
  expect(
    (
      await create({
        requestKey,
        items: [{ productId: 1, quantity: 2 }],
        totalCents: 1,
      })
    ).status,
  ).toBe(400);
  expect(
    (await create({ requestKey, items: [{ productId: 1, quantity: 0 }] }))
      .status,
  ).toBe(400);
  expect(
    (
      await create({
        requestKey,
        items: [
          { productId: 1, quantity: 1 },
          { productId: 1, quantity: 1 },
        ],
      })
    ).status,
  ).toBe(400);
  expect((await create()).status).toBe(201);
  expect(
    (await create({ requestKey, items: [{ productId: 1, quantity: 1 }] }))
      .status,
  ).toBe(409);
});
test('invalid price never falls back to Online Price and payment mismatches cannot complete', async () => {
  await db.update(schema.productsTable).set({ inPersonPrice: null });
  expect((await create()).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
  await db.update(schema.productsTable).set({ inPersonPrice: 600 });
  await create();
  amount = 1;
  expect((await event()).status).toBe(400);
  amount = 1200;
  location = 'other';
  expect((await event()).status).toBe(400);
  expect(await db.select().from(schema.ordersTable)).toHaveLength(0);
});
test('failed and cancelled evidence stays distinct, and later verified completion cannot regress', async () => {
  await create();
  status = 'FAILED';
  expect((await event()).status).toBe(200);
  expect((await db.select().from(schema.inPersonSales))[0].state).toBe(
    'failed',
  );
  status = 'CANCELED';
  await event();
  expect((await db.select().from(schema.inPersonSales))[0].state).toBe(
    'cancelled',
  );
  status = 'COMPLETED';
  await event();
  status = 'FAILED';
  await event();
  expect((await db.select().from(schema.inPersonSales))[0].state).toBe('paid');
  expect(await db.select().from(schema.ordersTable)).toHaveLength(1);
});

test('staff guard rejects ordinary customers for creation and status', async () => {
  state.role = 'user';
  await db.update(schema.memberTable).set({ role: 'member' });
  expect((await create()).status).toBe(403);
  expect(
    (await sales.request('/admin/in-person-sales/unknown', {}, env)).status,
  ).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('concurrent creation retains one sale and one provider idempotency identity', async () => {
  const responses = await Promise.all([create(), create()]);
  expect(responses.map(response => response.status)).toEqual([201, 201]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  expect(bodies[0].saleId).toBe(bodies[1].saleId);
  expect(await db.select().from(schema.inPersonSales)).toHaveLength(1);
  const keys = fetchMock.mock.calls
    .filter(([url]) => String(url).includes('payment-links'))
    .map(([, init]) => JSON.parse(String(init?.body)).idempotency_key);
  expect(new Set(keys).size).toBe(1);
  const events = await Promise.all([event(), event()]);
  expect(events.map(response => response.status)).toEqual([200, 200]);
  expect(await db.select().from(schema.ordersTable)).toHaveLength(1);
});

test('lost provider response leaves a recoverable sale with the same payload and key', async () => {
  const original = fetchMock.getMockImplementation()!;
  let lost = true;
  fetchMock.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (lost && String(url).includes('payment-links')) {
      lost = false;
      throw new Error('Lost response');
    }
    return response;
  });
  expect((await create()).status).toBe(502);
  const [sale] = await db.select().from(schema.inPersonSales);
  expect(
    await (
      await sales.request(`/admin/in-person-sales/${sale.id}`, {}, env)
    ).json(),
  ).toMatchObject({
    outcome: 'unknown',
    paymentStatus: 'pending',
    paymentUrl: null,
  });
  expect((await create()).status).toBe(201);
  const payloads = fetchMock.mock.calls
    .filter(([url]) => String(url).includes('payment-links'))
    .map(([, init]) => init?.body);
  expect(payloads).toHaveLength(2);
  expect(payloads[0]).toBe(payloads[1]);
  const paid = await event();
  expect(paid.status).toBe(200);
  const [order] = await db.select().from(schema.ordersTable);
  fetchMock.mockClear();
  expect(
    (
      await admin.request(
        `/admin/orders/${order.id}/retry`,
        { method: 'POST' },
        env,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await admin.request(
        `/admin/orders/${order.id}/reconcile`,
        { method: 'POST' },
        env,
      )
    ).status,
  ).toBe(200);
  expect(fetchMock).not.toHaveBeenCalled();
});

async function mappedPhone() {
  phone = true;
  await db.insert(schema.squareCatalogMappings).values({
    id: 'mapping',
    productId: 1,
    catalogId: 1,
    environment: 'sandbox',
    merchantId: 'merchant',
    locationId: 'location',
    itemId: 'item',
    variationId: 'variation',
  });
}
test('verified POS sale snapshots actual amounts and has no fabricated customer or Slant work', async () => {
  await mappedPhone();
  await db.update(schema.productsTable).set({ price: 99, inPersonPrice: 900 });
  const delivered = await Promise.all([event(), event()]);
  expect(delivered.map(r => r.status)).toEqual([200, 200]);
  const [order] = await db.select().from(schema.ordersTable);
  expect(order).toMatchObject({
    source: 'phone',
    fulfillmentType: 'in_person',
    userId: null,
    shipToName: null,
    customerEmail: null,
    totalAmountCents: 1200,
    status: 'handed_over',
  });
  expect(JSON.parse(order.itemSnapshot!)).toEqual([
    {
      productId: 1,
      name: 'Sold Widget',
      quantity: 2,
      unitAmountCents: 600,
      lineTotalCents: 1200,
      squareVariationId: 'variation',
    },
  ]);
  expect(await db.select().from(schema.ordersTable)).toHaveLength(1);
  expect(
    await (
      await sales.request('/admin/square-phone-intake/payment', {}, env)
    ).json(),
  ).toMatchObject({ state: 'recorded', error: null, orderId: order.id });
  expect(
    (await admin.request(`/admin/orders/${order.id}`, {}, env)).status,
  ).toBe(200);
  status = 'FAILED';
  await event();
  expect((await db.select().from(schema.ordersTable))[0].paymentStatus).toBe(
    'paid',
  );
  expect(
    fetchMock.mock.calls.every(([url]) => String(url).includes('square')),
  ).toBe(true);
});
test('unknown POS mapping remains diagnosable and can reconcile after mapping is restored', async () => {
  phone = true;
  expect(await (await event()).json()).toMatchObject({ intake: 'unmatched' });
  expect(await db.select().from(schema.ordersTable)).toHaveLength(0);
  expect((await db.select().from(schema.squarePhoneIntake))[0]).toMatchObject({
    state: 'unmatched',
    error: 'unknown_catalog_mapping',
  });
  await mappedPhone();
  expect(
    (
      await sales.request(
        '/admin/square-phone-intake/payment/reconcile',
        { method: 'POST' },
        env,
      )
    ).status,
  ).toBe(200);
  expect(await db.select().from(schema.ordersTable)).toHaveLength(1);
});
test('retrieval outage persists pending POS intake and an authorized retry recovers it', async () => {
  await mappedPhone();
  const original = fetchMock.getMockImplementation()!;
  let unavailable = true;
  fetchMock.mockImplementation(async (url, init) => {
    if (unavailable && String(url).includes('/orders/'))
      throw new Error('offline');
    return original(url, init);
  });
  expect((await event()).status).toBe(502);
  expect((await db.select().from(schema.squarePhoneIntake))[0]).toMatchObject({
    state: 'pending',
    error: 'awaiting_order_evidence',
  });
  unavailable = false;
  expect(
    (
      await sales.request(
        '/admin/square-phone-intake/payment/reconcile',
        { method: 'POST' },
        env,
      )
    ).status,
  ).toBe(200);
  expect(await db.select().from(schema.ordersTable)).toHaveLength(1);
});
test('wrong location, incomplete payment, unknown references and QR payments never become phone sales', async () => {
  await mappedPhone();
  location = 'other';
  await event();
  expect(await db.select().from(schema.ordersTable)).toHaveLength(0);
  location = 'location';
  status = 'APPROVED';
  await event();
  expect(await db.select().from(schema.squarePhoneIntake)).toHaveLength(0);
  status = 'COMPLETED';
  reference = 'unrecognized-api-reference';
  await event();
  expect((await db.select().from(schema.squarePhoneIntake))[0].error).toBe(
    'unrecognized_order_reference',
  );
  await create();
  await event();
  expect((await db.select().from(schema.ordersTable))[0].source).toBe('qr');
  expect(await db.select().from(schema.ordersTable)).toHaveLength(1);
});
test('POS intake reads and retries reject nonstaff without provider work', async () => {
  await mappedPhone();
  await event();
  await db.update(schema.memberTable).set({ role: 'member' });
  state.role = 'user';
  fetchMock.mockClear();
  expect(
    (await sales.request('/admin/square-phone-intake/payment', {}, env)).status,
  ).toBe(403);
  expect(
    (
      await sales.request(
        '/admin/square-phone-intake/payment/reconcile',
        { method: 'POST' },
        env,
      )
    ).status,
  ).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});

async function paidQR() {
  await create();
  await event();
  return (await db.select().from(schema.ordersTable))[0];
}
function refund(
  orderId: number,
  body: object = { reason: 'Customer request' },
) {
  return admin.request(
    `/admin/orders/${orderId}/cancel-refund`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}
test('Square refund stays pending until authoritative completion and never calls Slant for QR', async () => {
  const order = await paidQR();
  fetchMock.mockClear();
  expect(await (await refund(order.id)).json()).toMatchObject({
    state: 'pending',
    success: false,
    squareRefundId: 'refund',
  });
  expect((await db.select().from(schema.ordersTable))[0]).toMatchObject({
    paymentStatus: 'paid',
    refundStatus: 'pending',
    refundAmountCents: 1200,
  });
  refundStatus = 'COMPLETED';
  expect(
    await (
      await admin.request(
        `/admin/orders/${order.id}/reconcile`,
        { method: 'POST' },
        env,
      )
    ).json(),
  ).toMatchObject({ state: 'completed', success: true });
  expect((await db.select().from(schema.ordersTable))[0]).toMatchObject({
    paymentStatus: 'refunded',
    refundStatus: 'completed',
  });
  await refund(order.id);
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/refunds') && init?.method === 'POST',
    ),
  ).toHaveLength(1);
  expect(
    fetchMock.mock.calls.every(([url]) => String(url).includes('square')),
  ).toBe(true);
});
test('concurrent refund and lost responses reuse one durable identity and financial payload', async () => {
  const order = await paidQR();
  const original = fetchMock.getMockImplementation()!;
  let lost = true;
  fetchMock.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (lost && String(url).endsWith('/refunds')) {
      lost = false;
      throw new Error('lost refund response');
    }
    return response;
  });
  await Promise.all([refund(order.id), refund(order.id)]);
  await refund(order.id);
  expect(await db.select().from(schema.squareRefundOperations)).toHaveLength(1);
  const payloads = fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url).endsWith('/refunds') && init?.method === 'POST',
    )
    .map(([, init]) => String(init?.body));
  expect(payloads.length).toBeGreaterThan(0);
  expect(new Set(payloads).size).toBe(1);
  expect((await db.select().from(schema.ordersTable))[0].paymentStatus).toBe(
    'paid',
  );
});
test('nonstaff, invalid bodies and shipped orders without override cannot refund', async () => {
  const order = await paidQR();
  fetchMock.mockClear();
  expect((await refund(order.id, { amount: 1 })).status).toBe(400);
  await db
    .update(schema.ordersTable)
    .set({
      source: 'online',
      fulfillmentType: 'slant',
      status: 'shipped',
      slantStatus: 'SHIPPED',
      fulfillmentState: 'processed',
    });
  expect((await refund(order.id)).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
  await db.update(schema.memberTable).set({ role: 'member' });
  state.role = 'user';
  expect((await refund(order.id, { override: true })).status).toBe(403);
});
test('online refund waits for confirmed cancellation and uncertain DELETE is reconciled without repeat', async () => {
  const order = await paidQR();
  await db
    .update(schema.ordersTable)
    .set({
      source: 'online',
      fulfillmentType: 'slant',
      status: 'paid',
      slantStatus: 'DRAFT',
      fulfillmentState: 'drafted',
      slantPublicOrderId: 'slant-order',
    });
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url).includes('/orders/slant-order')) {
      if (init?.method === 'DELETE')
        throw new Error('lost cancellation response');
      return Response.json({
        data: {
          order: {
            publicId: 'slant-order',
            status: 'CANCELED',
            metadata: { externalOrderId: order.orderNumber },
          },
        },
      });
    }
    return original(url, init);
  });
  expect(await (await refund(order.id)).json()).toMatchObject({
    state: 'cancel_unknown',
    success: false,
  });
  expect(
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/refunds')),
  ).toHaveLength(0);
  refundStatus = 'COMPLETED';
  expect(await (await refund(order.id)).json()).toMatchObject({
    state: 'completed',
  });
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes('slant-order') && init?.method === 'DELETE',
    ),
  ).toHaveLength(1);
  expect((await db.select().from(schema.ordersTable))[0]).toMatchObject({
    status: 'canceled',
    paymentStatus: 'refunded',
  });
});
test('explicit override keeps the existing shipped-order policy while phone refunds avoid manufacture', async () => {
  await mappedPhone();
  await event();
  const [order] = await db.select().from(schema.ordersTable);
  refundStatus = 'FAILED';
  expect(await (await refund(order.id)).json()).toMatchObject({
    state: 'failed',
    success: false,
  });
  expect((await db.select().from(schema.ordersTable))[0].paymentStatus).toBe(
    'paid',
  );
  expect(
    fetchMock.mock.calls.every(([url]) => String(url).includes('square')),
  ).toBe(true);
});

test('explicit shipped override permits recovery after a rejected Slant cancellation', async () => {
  const order = await paidQR();
  await db
    .update(schema.ordersTable)
    .set({
      source: 'online',
      fulfillmentType: 'slant',
      status: 'shipped',
      slantStatus: 'SHIPPED',
      fulfillmentState: 'processed',
      slantPublicOrderId: 'slant-order',
    });
  const original = fetchMock.getMockImplementation()!;
  refundStatus = 'COMPLETED';
  fetchMock.mockImplementation(async (url, init) =>
    String(url).includes('/orders/slant-order')
      ? new Response('Cannot cancel', { status: 409 })
      : original(url, init),
  );
  expect(
    await (
      await refund(order.id, { reason: 'Customer request', override: true })
    ).json(),
  ).toMatchObject({ state: 'completed', success: true });
  expect((await db.select().from(schema.ordersTable))[0]).toMatchObject({
    paymentStatus: 'refunded',
    status: 'shipped',
  });
});
test('ambiguous manufacturing cannot be refunded without first recovering its identity', async () => {
  const order = await paidQR();
  await db
    .update(schema.ordersTable)
    .set({
      source: 'online',
      fulfillmentType: 'slant',
      status: 'paid_fulfillment_failed',
      fulfillmentState: 'draft_unknown',
    });
  fetchMock.mockClear();
  expect((await refund(order.id, { override: true })).status).toBe(409);
  expect(fetchMock).not.toHaveBeenCalled();
});
