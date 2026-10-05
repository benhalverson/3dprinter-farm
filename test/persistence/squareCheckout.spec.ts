import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { mockEnv } from '../mocks/env';

const state = vi.hoisted(() => ({ db: undefined as unknown, userId: 'owner' }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => state.db }));
vi.mock('../../lib/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: async () =>
        state.userId ? { user: { id: state.userId }, session: {} } : null,
    },
  }),
}));
vi.mock('../../src/utils/profileCrypto', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/utils/profileCrypto')>()),
  decryptStoredShippingProfile: async (profile: unknown) => profile,
}));

import { createPaidOrderFulfillment } from '../../src/modules/paidOrderFulfillment';
import admin from '../../src/routes/adminOrders';
import route from '../../src/routes/checkoutQuotes';
import notifications from '../../src/routes/notifications';
import orders from '../../src/routes/orders';
import { recordSlantLifecycle } from '../../src/modules/slantLifecycle';
import payments from '../../src/routes/payments';

const cartId = '11111111-1111-4111-8111-111111111111';
const filamentId = '22222222-2222-4222-8222-222222222222';
let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const env = mockEnv();
const fetchMock = vi.fn<typeof fetch>();
const availability = {
  success: true,
  data: [
    {
      publicId: filamentId,
      profile: 'PLA',
      hexValue: '#000000',
      color: 'Black',
      provider: 'Slant 3D',
      available: true,
    },
  ],
};
/** Calls the actual quote HTTP route with isolated SQLite and controlled providers. */
function request(id?: string, body: object = {}) {
  return route.request(
    `/cart/${cartId}/quotes${id ? `/${id}` : ''}`,
    id
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
    env,
  );
}
/** Requests and checks a successfully persisted quote fixture. */
async function quote() {
  const response = await request();
  expect(response.status).toBe(200);
  return response.json();
}
beforeEach(async () => {
  state.userId = 'owner';
  env.ORDER_NOTIFICATIONS_ENABLED = 'false';
  env.ORDER_EMAIL = undefined;
  env.ORDER_ADMIN_EMAIL = undefined;
  client = createClient({ url: ':memory:' });
  db = drizzle(client, { schema });
  state.db = db;
  await migrate(db, { migrationsFolder: '.generated/quote-test-migrations' });
  await db.insert(schema.users).values({
    id: 'owner',
    name: 'Owner',
    email: 'owner@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    shippingAddress: '10 Main Street',
    city: 'Seattle',
    state: 'WA',
    zipCode: '98101',
    country: 'US',
  });
  await db
    .insert(schema.shoppingCarts)
    .values({ id: cartId, userId: 'owner', accessVersion: 'version' });
  await db.insert(schema.productsTable).values({
    id: 1,
    name: 'Bracket',
    description: 'A bracket',
    stl: 'file',
    price: 0.29,
    skuNumber: 'BRACKET',
    filamentType: 'PLA',
    publicFileServiceId: 'print-file',
  });
  await db.insert(schema.cart).values({
    id: 1,
    cartId,
    accessVersion: 'version',
    userId: 'owner',
    skuNumber: 'BRACKET',
    quantity: 3,
    filamentType: 'PLA',
    filamentId,
    color: 'Black',
  });
  env.COLOR_CACHE = {
    get: vi.fn(async () => JSON.stringify(availability)),
  } as unknown as KVNamespace;
  vi.stubGlobal('fetch', fetchMock);
  fetchMock
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ data: { order: { deliveryCost: '1.13' } } }),
    );
});
afterEach(() => {
  client.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const requestKey = '33333333-3333-4333-8333-333333333333';
let reference = '';
let squareLinkCalls = 0;
let slantDraftCalls = 0;
let slantProcessCalls = 0;
let paymentAmount = 200;
let paymentCurrency = 'USD';
let paymentStatus = 'COMPLETED';
let paymentLocation = 'location';
let processAmbiguous = false;
let draftAmbiguous = false;
/** Configures deterministic provider responses; no external effect leaves the test process. */
function providers() {
  Object.assign(env, {
    SQUARE_ENVIRONMENT: 'sandbox',
    SQUARE_ACCESS_TOKEN: 'test',
    SQUARE_MERCHANT_ID: 'merchant',
    SQUARE_LOCATION_ID: 'location',
    SQUARE_WEBHOOK_SIGNATURE_KEY: 'test-signature-key',
    SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://api.example/webhook/square',
  });
  squareLinkCalls = slantDraftCalls = slantProcessCalls = 0;
  paymentAmount = 200;
  paymentCurrency = 'USD';
  paymentStatus = 'COMPLETED';
  paymentLocation = 'location';
  processAmbiguous = false;
  draftAmbiguous = false;
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
      squareLinkCalls++;
      const input = JSON.parse(String(init?.body));
      reference = input.order.reference_id;
      expect(input.idempotency_key).toBe(reference);
      expect(input.order.line_items).toMatchObject([
        { quantity: '3', base_price_money: { amount: 29, currency: 'USD' } },
        {
          name: 'Slant3D shipping',
          base_price_money: { amount: 113, currency: 'USD' },
        },
      ]);
      return Response.json({
        payment_link: {
          id: 'link',
          order_id: 'square-order',
          url: 'https://square.example/pay',
        },
      });
    }
    if (path.includes('squareupsandbox.com/v2/orders/'))
      return Response.json({
        order: {
          id: 'square-order',
          reference_id: reference,
          location_id: 'location',
          total_money: { amount: 200, currency: 'USD' },
        },
      });
    if (path.includes('/payments/'))
      return Response.json({
        payment: {
          id: 'payment',
          order_id: 'square-order',
          location_id: paymentLocation,
          status: paymentStatus,
          amount_money: { amount: paymentAmount, currency: paymentCurrency },
          total_money: { amount: paymentAmount, currency: paymentCurrency },
        },
      });
    if (path.endsWith('/orders') && init?.method === 'POST') {
      slantDraftCalls++;
      if (draftAmbiguous) throw new Error('lost draft');
      return Response.json({ publicOrderId: 'slant-order' });
    }
    if (path.endsWith('/orders/slant-order') && init?.method === 'POST') {
      slantProcessCalls++;
      if (processAmbiguous) throw new Error('lost process');
      return Response.json({ status: 'PROCESSING' });
    }
    if (path.endsWith('/orders/slant-order'))
      return Response.json({
        publicOrderId: 'slant-order',
        orderNumber: `SQ-${reference}`,
        status: 'PROCESSING',
      });
    throw new Error('Unexpected external request');
  });
}
/** Initiates checkout through the authenticated HTTP contract. */
function checkout(quoteId: string, key = requestKey, extra = {}) {
  return payments.request(
    `/cart/${cartId}/checkout`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId, requestKey: key, ...extra }),
    },
    env,
  );
}
/** Computes a test Square signature using the fixed configured URL and exact raw body. */
async function signature(
  body: string,
  url = env.SQUARE_WEBHOOK_NOTIFICATION_URL,
) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SQUARE_WEBHOOK_SIGNATURE_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(url + body)),
  );
  return btoa(String.fromCharCode(...bytes));
}
/** Delivers signed events at the real HTTP ingress. */
async function event(overrides = {}, tamper = false) {
  const body = JSON.stringify({
    type: 'payment.updated',
    merchant_id: 'merchant',
    data: { id: 'payment', type: 'payment' },
    ...overrides,
  });
  return payments.request(
    '/webhook/square',
    {
      method: 'POST',
      headers: {
        'x-square-hmacsha256-signature': await signature(body),
        'Content-Type': 'application/json',
      },
      body: body + (tamper ? ' ' : ''),
    },
    env,
  );
}
/** Creates a reviewed quote before switching to payment provider responses. */
async function prepared() {
  const created = await quote();
  providers();
  const response = await checkout(created.id);
  expect(response.status).toBe(200);
  return created;
}

test('shipping inclusive immutable checkout survives provider retries and records one paid manufactured order under concurrent delivery', async () => {
  const created = await prepared();
  const attempts = await db.select().from(schema.checkoutAttempts);
  expect(attempts).toHaveLength(1);
  await db
    .update(schema.productsTable)
    .set({ price: 99 })
    .where(eq(schema.productsTable.id, 1));
  await db
    .update(schema.cart)
    .set({ quantity: 4 })
    .where(eq(schema.cart.id, 1));
  expect((await checkout(created.id)).status).toBe(200);
  const responses = await Promise.all([event(), event(), event()]);
  expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
  const stored = await db.select().from(schema.ordersTable);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    paymentStatus: 'paid',
    totalAmountCents: 200,
    shippingAmountCents: 113,
    currency: 'USD',
    squarePaymentId: 'payment',
    fulfillmentState: 'processed',
  });
  expect(slantDraftCalls).toBe(1);
  expect(slantProcessCalls).toBe(1);
  expect((await db.select().from(schema.cart))[0].quantity).toBe(4);
  expect(
    (await db.select().from(schema.orderEventsTable)).map(e => e.type).sort(),
  ).toEqual(['square_fulfillment_processed', 'square_payment_verified']);
  await event();
  expect(slantProcessCalls).toBe(1);
  const read = await orders.request(`/orders/${stored[0].id}`, {}, env);
  expect(read.status).toBe(200);
});
test.each([
  { amount: 199 },
  { currency: 'EUR' },
  { location: 'foreign' },
  { merchant_id: 'foreign' },
])('rejects mismatched payment evidence %j', async input => {
  await prepared();
  paymentAmount = input.amount ?? 200;
  paymentCurrency = input.currency ?? 'USD';
  paymentLocation = input.location ?? 'location';
  expect(
    (await event(input.merchant_id ? { merchant_id: input.merchant_id } : {}))
      .status,
  ).toBe(400);
  expect(await db.select().from(schema.ordersTable)).toHaveLength(0);
  expect(slantDraftCalls).toBe(0);
});
test.each([
  'PENDING',
  'FAILED',
  'CANCELED',
])('never authorizes fulfillment for %s payments', async status => {
  await prepared();
  paymentStatus = status;
  expect((await event()).status).toBe(200);
  expect(await db.select().from(schema.ordersTable)).toHaveLength(0);
});
test('rejects raw body and fixed URL signature tampering', async () => {
  await prepared();
  expect((await event({}, true)).status).toBe(403);
  const body = JSON.stringify({
    type: 'payment.updated',
    merchant_id: 'merchant',
    data: { id: 'payment', type: 'payment' },
  });
  expect(
    (
      await payments.request(
        '/webhook/square',
        {
          method: 'POST',
          headers: {
            'x-square-hmacsha256-signature': await signature(
              body,
              'https://evil.example/webhook/square',
            ),
          },
          body,
        },
        env,
      )
    ).status,
  ).toBe(403);
  expect(await db.select().from(schema.ordersTable)).toHaveLength(0);
});
test('preserves payment and retained Slant ID on process ambiguity; reconciliation does not manufacture twice', async () => {
  await prepared();
  processAmbiguous = true;
  expect((await event()).status).toBe(200);
  const [order] = await db.select().from(schema.ordersTable);
  expect(order).toMatchObject({
    paymentStatus: 'paid',
    fulfillmentState: 'process_unknown',
    slantPublicOrderId: 'slant-order',
    status: 'paid_fulfillment_failed',
  });
  await event();
  expect(slantProcessCalls).toBe(1);
  await createPaidOrderFulfillment({
    db: state.db as never,
    env,
  }).reconcilePaidOrder(order.id);
  expect((await db.select().from(schema.ordersTable))[0].fulfillmentState).toBe(
    'processed',
  );
  expect(slantProcessCalls).toBe(1);
});
test('unknown draft cannot be repeated; verified explicit draft association can recover', async () => {
  await prepared();
  draftAmbiguous = true;
  await event();
  const [order] = await db.select().from(schema.ordersTable);
  expect(order.fulfillmentState).toBe('draft_unknown');
  await event();
  expect(slantDraftCalls).toBe(1);
  await createPaidOrderFulfillment({
    db: state.db as never,
    env,
  }).reconcilePaidOrder(order.id, 'slant-order');
  expect((await db.select().from(schema.ordersTable))[0].fulfillmentState).toBe(
    'processed',
  );
  expect(slantDraftCalls).toBe(1);
});
test('authorization and conflicting quote/key inputs fail without provider checkout', async () => {
  const created = await quote();
  providers();
  state.userId = 'other';
  expect((await checkout(created.id)).status).toBe(404);
  state.userId = '';
  expect((await checkout(created.id)).status).toBe(401);
  state.userId = 'owner';
  expect(
    (await checkout(created.id, requestKey, { totalCents: 1 })).status,
  ).toBe(400);
  expect(squareLinkCalls).toBe(0);
});
test('concurrent initiation consumes the same quote and returns one logical attempt', async () => {
  const created = await quote();
  providers();
  const responses = await Promise.all([
    checkout(created.id),
    checkout(created.id),
  ]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect(await db.select().from(schema.checkoutAttempts)).toHaveLength(1);
  expect(
    new Set(
      (await Promise.all(responses.map(r => r.json()))).map(r => r.attemptId),
    ).size,
  ).toBe(1);
});
test('late quote invalidation atomically prevents checkout', async () => {
  const created = await quote();
  providers();
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url).includes('/locations/'))
      await db
        .update(schema.checkoutQuotes)
        .set({ invalidated: true })
        .where(eq(schema.checkoutQuotes.id, created.id));
    return original(url, init);
  });
  expect((await checkout(created.id)).status).toBe(409);
  expect(squareLinkCalls).toBe(0);
  expect(await db.select().from(schema.checkoutAttempts)).toHaveLength(0);
});

test.each([
  'material',
  'sku',
  'price',
  'address',
  'expiry',
  'invalidation',
])('atomic consumption rejects %s changed immediately before the batch', async change => {
  const created = await quote();
  providers();
  state.db = new Proxy(db, {
    get(target, key, receiver) {
      if (key === 'batch')
        return async (queries: never) => {
          if (change === 'material')
            await db
              .update(schema.productsTable)
              .set({ filamentType: 'PETG' })
              .where(eq(schema.productsTable.id, 1));
          if (change === 'sku')
            await db
              .update(schema.cart)
              .set({ skuNumber: 'different' })
              .where(eq(schema.cart.id, 1));
          if (change === 'price')
            await db
              .update(schema.productsTable)
              .set({ price: 0.3 })
              .where(eq(schema.productsTable.id, 1));
          if (change === 'address')
            await db
              .update(schema.users)
              .set({ shippingAddress: '20 New Street' })
              .where(eq(schema.users.id, 'owner'));
          if (change === 'expiry')
            await db
              .update(schema.checkoutQuotes)
              .set({ expiresAt: Date.now() - 1 })
              .where(eq(schema.checkoutQuotes.id, created.id));
          if (change === 'invalidation')
            await db
              .update(schema.checkoutQuotes)
              .set({ invalidated: true })
              .where(eq(schema.checkoutQuotes.id, created.id));
          return target.batch(queries);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  expect((await checkout(created.id)).status).toBe(409);
  expect(squareLinkCalls).toBe(0);
  expect(await db.select().from(schema.checkoutAttempts)).toHaveLength(0);
  expect(
    (await db.select().from(schema.checkoutQuotes))[0].consumedAttemptId,
  ).toBeNull();
});
test('replays persisted checkout identity after a lost Square response without another logical payment', async () => {
  const created = await quote();
  providers();
  const implementation = fetchMock.getMockImplementation()!;
  let lost = true;
  fetchMock.mockImplementation(async (url, init) => {
    const response = await implementation(url, init);
    if (String(url).includes('payment-links') && lost) {
      lost = false;
      throw new Error('lost after provider acceptance');
    }
    return response;
  });
  expect((await checkout(created.id)).status).toBe(502);
  const [original] = await db.select().from(schema.checkoutAttempts);
  state.db = drizzle(client, { schema });
  expect((await checkout(created.id)).status).toBe(200);
  expect(await db.select().from(schema.checkoutAttempts)).toHaveLength(1);
  expect((await db.select().from(schema.checkoutAttempts))[0].id).toBe(
    original.id,
  );
});
test('paid state survives malformed process confirmation and secure webhook rejects missing Slant secret', async () => {
  await prepared();
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) =>
    String(url).endsWith('/orders/slant-order') && init?.method === 'POST'
      ? Response.json({})
      : implementation(url, init),
  );
  await event();
  const [order] = await db.select().from(schema.ordersTable);
  expect(order).toMatchObject({
    paymentStatus: 'paid',
    fulfillmentState: 'process_unknown',
    slantPublicOrderId: 'slant-order',
  });
  expect(
    (
      await orders.request(
        '/webhook/slant3d',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: 'slant-order', status: 'SHIPPED' }),
        },
        { ...env, SLANT_WEBHOOK_SECRET: undefined },
      )
    ).status,
  ).toBe(503);
});

test('durable asset holds release after confirmation and remain discoverable on ambiguity', async () => {
  await prepared();
  await db.insert(schema.productAssets).values({
    id: 'print-asset',
    ownerId: 'owner',
    draftId: 'draft',
    kind: 'print',
    objectKey: 'print-key',
    providerId: 'print-file',
    encryptionKey: 'test-key',
    references: [],
    status: 'active',
    revision: 1,
  });
  processAmbiguous = true;
  await event();
  const [hold] = await db.select().from(schema.productAssetReferenceAttempts);
  expect(hold.state).toBe('unresolved');
  expect((await db.select().from(schema.productAssets))[0].references).toEqual([
    hold.id,
  ]);
  const [order] = await db.select().from(schema.ordersTable);
  state.db = drizzle(client, { schema });
  await createPaidOrderFulfillment({
    db: state.db as never,
    env,
  }).reconcilePaidOrder(order.id);
  expect(
    (await db.select().from(schema.productAssetReferenceAttempts))[0].state,
  ).toBe('released');
  expect((await db.select().from(schema.productAssets))[0].references).toEqual(
    [],
  );
  expect(slantProcessCalls).toBe(1);
});
test('replays incomplete terminal cart cleanup after an isolated database failure without provider effects', async () => {
  await prepared();
  let fail = true;
  state.db = new Proxy(db, {
    get(target, key, receiver) {
      if (key === 'delete')
        return (...args: never[]) => {
          if (fail) {
            fail = false;
            throw new Error('cleanup write unavailable');
          }
          return target.delete(...args);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  await event();
  const [order] = await db.select().from(schema.ordersTable);
  expect(order.fulfillmentState).toBe('processed');
  expect(await db.select().from(schema.cart)).toHaveLength(1);
  state.db = drizzle(client, { schema });
  await event();
  expect(await db.select().from(schema.cart)).toHaveLength(0);
  expect(slantDraftCalls).toBe(1);
  expect(slantProcessCalls).toBe(1);
  expect(
    (await db.select().from(schema.orderEventsTable)).map(e => e.type).sort(),
  ).toEqual(['square_fulfillment_processed', 'square_payment_verified']);
});

test('existing authorized admin recovery reads retained Slant identity and rejects unsafe retries', async () => {
  await prepared();
  processAmbiguous = true;
  await event();
  const [order] = await db.select().from(schema.ordersTable);
  expect(
    (
      await admin.request(
        `/admin/orders/${order.id}/retry`,
        { method: 'POST' },
        env,
      )
    ).status,
  ).toBe(403);
  const [member] = await db.select().from(schema.memberTable);
  await db
    .update(schema.memberTable)
    .set({ role: 'admin' })
    .where(eq(schema.memberTable.id, member.id));
  expect(
    (
      await admin.request(
        `/admin/orders/${order.id}/retry`,
        { method: 'POST' },
        env,
      )
    ).status,
  ).toBe(409);
  const reconciled = await admin.request(
    `/admin/orders/${order.id}/reconcile`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
    env,
  );
  expect(reconciled.status).toBe(200);
  expect(
    (await db.select().from(schema.orderNotificationAttemptsTable))
      .map(row => row.notificationType)
      .sort(),
  ).toEqual(['admin_failure_alert', 'order_confirmation']);
  expect(await reconciled.json()).toMatchObject({
    resultStatus: 'processed',
    localStatus: 'processing',
    slantStatus: 'PROCESSING',
  });
  expect(slantDraftCalls).toBe(1);
  expect(slantProcessCalls).toBe(1);
  expect(
    (await db.select().from(schema.ordersTable))[0].processedAt,
  ).not.toBeNull();
});

/** Authorizes only the local fixture's existing owner for notification recovery. */
async function notificationAdmin() {
  await db.insert(schema.organizationTable).values({
    id: 'org_shared_catalog',
    name: 'Store',
    slug: 'store',
    createdAt: new Date(),
  });
  await db.insert(schema.memberTable).values({
    id: 'member-owner',
    organizationId: 'org_shared_catalog',
    userId: 'owner',
    role: 'admin',
    createdAt: new Date(),
  });
}

test('actual signed Square webhook queues one Cloudflare confirmation with sending disabled', async () => {
  await prepared();
  const send = vi.fn().mockResolvedValue({ messageId: 'mail-id' });
  env.ORDER_EMAIL = { send };
  await Promise.all([event(), event(), event()]);
  const queued = await db.select().from(schema.orderNotificationAttemptsTable);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({
    notificationType: 'order_confirmation',
    status: 'pending',
    recipientEmail: 'owner@example.com',
  });
  expect(send).not.toHaveBeenCalled();
  env.ORDER_NOTIFICATIONS_ENABLED = 'true';
  await event();
  await event();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toMatchObject({ to: 'owner@example.com' });
  expect(slantDraftCalls).toBe(1);
  expect(slantProcessCalls).toBe(1);
});

test('invalid signatures and mismatched Square evidence cannot enqueue emails', async () => {
  await prepared();
  env.ORDER_NOTIFICATIONS_ENABLED = 'true';
  const send = vi.fn();
  env.ORDER_EMAIL = { send };
  expect((await event({}, true)).status).toBe(403);
  paymentAmount = 199;
  expect((await event()).status).toBe(400);
  expect(
    await db.select().from(schema.orderNotificationAttemptsTable),
  ).toHaveLength(0);
  expect(send).not.toHaveBeenCalled();
});

test('actual Square fulfillment ambiguity queues only a redacted admin alert', async () => {
  await prepared();
  processAmbiguous = true;
  env.ORDER_NOTIFICATIONS_ENABLED = 'true';
  env.ORDER_ADMIN_EMAIL = 'admin@example.com';
  const send = vi.fn().mockResolvedValue({ messageId: 'alert-id' });
  env.ORDER_EMAIL = { send };
  expect((await event()).status).toBe(200);
  await event();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toMatchObject({ to: 'admin@example.com' });
  const queued = await db.select().from(schema.orderNotificationAttemptsTable);
  expect(queued).toHaveLength(1);
  expect(queued[0].notificationType).toBe('admin_failure_alert');
  expect(JSON.stringify(send.mock.calls)).not.toContain('lost process');
  expect(slantProcessCalls).toBe(1);
});

test('explicit admin recovery rebuilds a missing intent from durable Square events without provider reads', async () => {
  await prepared();
  await event();
  await db.delete(schema.orderNotificationAttemptsTable);
  await notificationAdmin();
  const [order] = await db.select().from(schema.ordersTable);
  const providerCalls = fetchMock.mock.calls.length;
  const response = await notifications.request(
    `/notifications/order/${order.id}/reconcile`,
    { method: 'POST' },
    env,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    verified: true,
    notifications: [{ status: 'disabled' }],
  });
  expect(
    await db.select().from(schema.orderNotificationAttemptsTable),
  ).toHaveLength(1);
  expect(fetchMock.mock.calls).toHaveLength(providerCalls);
});

test('a real post-fulfillment enqueue outage preserves acknowledgement and is recovered without provider calls', async () => {
  await prepared();
  let fail = true;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  state.db = new Proxy(db, {
    get(target, key, receiver) {
      if (key === 'insert')
        return (...args: Parameters<typeof db.insert>) => {
          if (args[0] === schema.orderNotificationAttemptsTable && fail) {
            fail = false;
            throw new Error('sensitive database envelope');
          }
          return target.insert(...args);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  expect((await event()).status).toBe(200);
  expect(
    await db.select().from(schema.orderNotificationAttemptsTable),
  ).toHaveLength(0);
  expect(JSON.stringify(log.mock.calls)).not.toContain(
    'sensitive database envelope',
  );
  expect(log).toHaveBeenCalledWith(
    'notification.square_reconciliation_pending',
  );
  log.mockRestore();
  state.db = db;
  await notificationAdmin();
  const [order] = await db.select().from(schema.ordersTable);
  const calls = fetchMock.mock.calls.length;
  const response = await notifications.request(
    `/notifications/order/${order.id}/reconcile`,
    { method: 'POST' },
    env,
  );
  expect(response.status).toBe(200);
  expect(
    await db.select().from(schema.orderNotificationAttemptsTable),
  ).toHaveLength(1);
  expect(fetchMock.mock.calls).toHaveLength(calls);
});

test('eligible admin retry reconciles original failure and new confirmation through the production hook', async () => {
  await prepared();
  const original = fetchMock.getMockImplementation();
  if (!original) throw new Error('provider fixture missing');
  let rejectDraft = true;
  fetchMock.mockImplementation(async (url, init) => {
    if (
      String(url).endsWith('/orders') &&
      init?.method === 'POST' &&
      rejectDraft
    ) {
      rejectDraft = false;
      return new Response('rejected fixture', { status: 400 });
    }
    return original(url, init);
  });
  expect((await event()).status).toBe(200);
  const [order] = await db.select().from(schema.ordersTable);
  expect(order.fulfillmentState).toBe('ready');
  await notificationAdmin();
  env.ORDER_NOTIFICATIONS_ENABLED = 'true';
  env.ORDER_ADMIN_EMAIL = 'admin@example.com';
  const send = vi.fn().mockResolvedValue({ messageId: 'email' });
  env.ORDER_EMAIL = { send };
  const response = await admin.request(
    `/admin/orders/${order.id}/retry`,
    { method: 'POST' },
    env,
  );
  expect(response.status).toBe(200);
  expect(
    (await db.select().from(schema.orderNotificationAttemptsTable))
      .map(row => row.notificationType)
      .sort(),
  ).toEqual(['admin_failure_alert', 'order_confirmation']);
  expect(send).toHaveBeenCalledTimes(2);
});

test.each([
  'resolve',
  'reject',
  'reconcile',
] as const)('retains authenticated cancellation during in-flight Slant %s and prevents manufacturing replay', async outcome => {
  await prepared();
  if (outcome === 'reconcile') {
    processAmbiguous = true;
    await event();
  }
  const original = fetchMock.getMockImplementation()!;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  fetchMock.mockImplementation(async (url, init) => {
    if (
      String(url).endsWith('/orders/slant-order') &&
      (outcome === 'reconcile'
        ? init?.method === 'GET'
        : init?.method === 'POST')
    ) {
      entered();
      await gate;
      if (outcome === 'reject') throw new Error('lost process response');
    }
    return original(url, init);
  });
  const [existing] = await db.select().from(schema.ordersTable);
  const operation =
    outcome === 'reconcile'
      ? createPaidOrderFulfillment({
          db: state.db as never,
          env,
        }).reconcilePaidOrder(existing.id)
      : event();
  await started;
  const [pending] = await db.select().from(schema.ordersTable);
  expect(pending.slantStatus).toBeNull();
  expect(
    (
      await recordSlantLifecycle(state.db as never, {
        eventId: 'cancel-in-flight',
        orderId: 'slant-order',
        status: 'CANCELED',
      })
    ).status,
  ).toBe(200);
  release();
  await operation;
  const [canceled] = await db.select().from(schema.ordersTable);
  expect(canceled).toMatchObject({
    slantStatus: 'CANCELED',
    status: 'canceled',
    fulfillmentState: 'canceled',
    paymentStatus: 'paid',
  });
  const calls = fetchMock.mock.calls.length;
  await createPaidOrderFulfillment({
    db: state.db as never,
    env,
  }).fulfillPaidOrder(canceled.id);
  await createPaidOrderFulfillment({
    db: state.db as never,
    env,
  }).reconcilePaidOrder(canceled.id);
  expect(fetchMock.mock.calls).toHaveLength(calls);
});

test('Slant shipment during actual process response cannot regress to PROCESSING', async () => {
  await prepared();
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (
      String(url).endsWith('/orders/slant-order') &&
      init?.method === 'POST'
    ) {
      expect(
        (
          await recordSlantLifecycle(state.db as never, {
            eventId: 'shipped-in-flight',
            orderId: 'slant-order',
            status: 'SHIPPED',
          })
        ).status,
      ).toBe(200);
    }
    return original(url, init);
  });
  await event();
  expect((await db.select().from(schema.ordersTable))[0]).toMatchObject({
    slantStatus: 'SHIPPED',
    status: 'shipped',
    fulfillmentState: 'processed',
    paymentStatus: 'paid',
  });
});
