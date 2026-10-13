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

import route from '../../src/routes/checkoutQuotes';
import orders from '../../src/routes/orders';
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

import { checkoutTools } from '../../src/shopping/checkout-tools';
import { commerceTools } from '../../src/shopping/commerce';
import { runInference } from '../../src/shopping/inference';
import { usageCost } from '../../src/shopping/pricing';
import type { RunInput } from '../../src/shopping/contracts';
const input = (): RunInput => ({
  runId: crypto.randomUUID(),
  uiRevision: 3,
  message: 'Buy this after review',
  context: [],
  cart: { id: cartId, revision: 0 },
});
const prepare = { name: 'checkout_prepare_review', arguments: {} };
const build = (run = input(), user = 'owner', publish = vi.fn()) =>
  checkoutTools(db as never, env, user, run, () => true, publish);
test('prepare review uses the real quote contract, omits profile/Print Files and cannot create payment', async () => {
  const publish = vi.fn();
  const tools = build(input(), 'owner', publish);
  const result = (await tools.execute(prepare)) as {
    review: { quoteId: string; totalCents: number };
  };
  expect(result).toMatchObject({
    status: 'review_required',
    review: {
      subtotalCents: 87,
      shippingCents: 113,
      totalCents: 200,
      confirmationRequired: true,
    },
  });
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'checkout_review', accountId: 'owner' }),
  );
  expect(JSON.stringify(result)).not.toMatch(
    /Main Street|owner@example|print-file|Lovelace|paymentUrl/,
  );
  const direct = await request(result.review.quoteId);
  expect(direct.status).toBe(200);
  expect((await direct.json()).totalCents).toBe(result.review.totalCents);
  expect(await db.select().from(schema.checkoutAttempts)).toEqual([]);
  expect(await db.select().from(schema.ordersTable)).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await tools.execute(prepare)).toMatchObject({
    status: 'review_already_prepared',
  });
});
test('another account and injected identity/payment fields cannot read or prepare a purchase', async () => {
  await db
    .insert(schema.users)
    .values({ id: 'other', name: 'Other', email: 'other@example.test' });
  await expect(build(input(), 'other').execute(prepare)).rejects.toMatchObject({
    status: 404,
  });
  for (const query of [
    { name: 'checkout_prepare_review', arguments: { ownerId: 'other' } },
    { name: 'charge', arguments: { amount: 1 } },
    { name: 'checkout_prepare_review', arguments: { confirmed: true } },
  ])
    await expect(build().execute(query)).rejects.toBeTruthy();
  const guest = await commerceTools(
    db as never,
    env,
    {},
    { ...input(), cart: undefined },
    'session',
    () => true,
    vi.fn(),
  );
  expect(guest).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
});
test('stale and expired quote facts cannot be presented as current review', async () => {
  const saved = await quote();
  await db
    .update(schema.productsTable)
    .set({ price: 99 })
    .where(eq(schema.productsTable.id, 1));
  expect(
    await build().execute({
      name: 'checkout_read_quote',
      arguments: { quoteId: saved.id },
    }),
  ).toMatchObject({ status: 'stale' });
  await db
    .update(schema.checkoutQuotes)
    .set({ invalidated: false, expiresAt: 0 })
    .where(eq(schema.checkoutQuotes.id, saved.id));
  expect(
    await build().execute({
      name: 'checkout_read_quote',
      arguments: { quoteId: saved.id },
    }),
  ).toMatchObject({ status: 'expired' });
  expect(await db.select().from(schema.checkoutAttempts)).toEqual([]);
});
test('owned-order answers share direct projection and expose only minimum safe facts', async () => {
  await db
    .insert(schema.users)
    .values({ id: 'other', name: 'Other', email: 'other@example.test' });
  await db.insert(schema.ordersTable).values([
    {
      id: 1,
      userId: 'owner',
      orderNumber: 'OWN',
      paymentStatus: 'paid',
      fulfillmentState: 'manual_review',
      customerSnapshot: 'secret profile',
      customerEmail: 'owner@example.com',
      totalAmountCents: 200,
      currency: 'USD',
    },
    {
      id: 2,
      userId: 'other',
      orderNumber: 'OTHER',
      paymentStatus: 'paid',
      totalAmountCents: 999,
    },
  ]);
  const result = await build().execute({
    name: 'customer_orders',
    arguments: {},
  });
  expect(result).toMatchObject({
    status: 'known',
    orders: [
      {
        id: 1,
        orderNumber: 'OWN',
        paymentStatus: 'paid',
        fulfillmentState: 'manual_review',
      },
    ],
    policy: 'unknown',
  });
  expect(JSON.stringify(result)).not.toMatch(
    /OTHER|profile|owner@example|squarePaymentId|slantPublicOrderId/,
  );
  expect(
    await build().execute({
      name: 'customer_order',
      arguments: { orderId: 2 },
    }),
  ).toMatchObject({ status: 'unknown', orders: [] });
  const direct = await orders.request('/orders/1', {}, env);
  expect(direct.status).toBe(200);
  expect(await direct.json()).toMatchObject({
    id: 1,
    paymentStatus: 'paid',
    fulfillmentState: 'manual_review',
  });
});
test('ambiguous checkout recovery is read-only and never relabels unknown as paid or failed', async () => {
  const saved = await quote();
  const attemptId = crypto.randomUUID();
  const requestKey=crypto.randomUUID();
  await db
    .update(schema.checkoutQuotes)
    .set({ consumedAttemptId: attemptId })
    .where(eq(schema.checkoutQuotes.id, saved.id));
  await db
    .insert(schema.checkoutAttempts)
    .values({
      id: attemptId,
      ownerId: 'owner',
      cartId,
      quoteId: saved.id,
      requestKey,
      snapshot: '{}',
      customerEmail: 'private@example.test',
      merchantId: 'merchant',
      locationId: 'location',
      createdAt: Date.now(),
    });
  fetchMock.mockClear();
  expect(
    await build().execute({
      name: 'checkout_attempt_status',
      arguments: { attemptId },
    }),
  ).toMatchObject({
    status: 'known',
    attempt: { state: 'unknown', order: null },
  });
  expect(await build().execute({name:'checkout_attempt_status',arguments:{requestKey}})).toMatchObject({status:'known',attempt:{state:'unknown'}});
  const direct = await payments.request(
    `/checkout-attempts/${attemptId}`,
    {},
    env,
  );
  expect(direct.status).toBe(200);
  expect(await direct.json()).toMatchObject({ state: 'unknown' });
  expect(
    await build(input(), 'other').execute({
      name: 'checkout_attempt_status',
      arguments: { attemptId },
    }),
  ).toMatchObject({ status: 'unknown', attempt: null });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await db.select().from(schema.checkoutAttempts)).toHaveLength(1);
});
const final = {
  components: [
    { id: 'products', component: 'ProductRail', entries: [] },
    { id: 'focus', component: 'ProductFocus', productId: null, images: [] },
  ],
  answer: 'catalog',
};
const usage = { prompt_tokens: 10, completion_tokens: 10 };
function completion(tool = false) {
  return {
    usage,
    choices: [
      {
        finish_reason: tool ? 'tool_calls' : 'stop',
        message: tool
          ? {
              tool_calls: [
                {
                  id: 'prepare',
                  type: 'function',
                  function: { name: prepare.name, arguments: '{}' },
                },
              ],
            }
          : { content: JSON.stringify(final) },
      },
    ],
  };
}
test('budgeted inference prepares trusted review with measured schema/cost evidence and no purchase', async () => {
  const started = performance.now();
  const run = input();
  const commerce = await commerceTools(
    db as never,
    env,
    { userId: 'owner' },
    run,
    'session',
    () => true,
    vi.fn(),
  );
  const infer = vi
    .fn()
    .mockResolvedValueOnce(completion(true))
    .mockResolvedValueOnce(completion());
  let cost = 0;
  const accounting = {
    reserve: vi.fn(async () => ({
      status: 'reserved' as const,
      id: crypto.randomUUID(),
    })),
    settle: vi.fn(async (_id: string, tokens: typeof usage | null) => {
      const charged = usageCost(tokens!);
      cost += charged;
      return charged;
    }),
  };
  const result = await runInference(run, 'session', {
    commerce,
    read: async () => [],
    infer,
    accounting,
    signal: new AbortController().signal,
    active: () => true,
    progress: vi.fn(),
  });
  expect(result.messages).toHaveLength(1);
  expect(accounting.reserve).toHaveBeenCalledTimes(2);
  expect(cost).toBe(13000);
  expect(JSON.stringify(infer.mock.calls)).not.toMatch(
    /Main Street|owner@example|print-file|Lovelace/,
  );
  expect(await db.select().from(schema.checkoutAttempts)).toEqual([]);
  process.stdout.write(
    JSON.stringify({
      event: 'shopping_checkout_contract_evaluation',
      taskSuccess: 1,
      schemaValidity: 1,
      latencyMs: Math.round(performance.now() - started),
      repairRate: 0,
      invocations: 2,
      estimatedNanodollars: cost,
      actualProviderSpend: 0,
    })+'\n',
  );
});
test('unavailable inference leaves direct quote and owned-order routes usable', async () => {
  const run = input();
  await expect(
    runInference(run, 'session', {
      commerce: build(run),
      read: async () => [],
      infer: vi.fn().mockRejectedValue(new Error('offline')),
      accounting: {
        reserve: async () => ({ status: 'reserved', id: 'reservation' }),
        settle: async () => 0,
      },
      signal: new AbortController().signal,
      active: () => true,
      progress: vi.fn(),
    }),
  ).rejects.toMatchObject({ reason: 'inference_unavailable' });
  expect((await request()).status).toBe(200);
  expect((await orders.request('/orders', {}, env)).status).toBe(200);
  expect(await db.select().from(schema.checkoutAttempts)).toEqual([]);
});
