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
  await db
    .insert(schema.organizationTable)
    .values({
      id: 'org_shared_catalog',
      name: 'Staff',
      slug: 'staff',
      createdAt: new Date(),
    });
  await db
    .insert(schema.memberTable)
    .values({
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
