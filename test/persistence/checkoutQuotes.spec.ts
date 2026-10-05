import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
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
import { quoteSnapshotSchema } from '../../src/modules/checkoutQuotes';
import {
  decryptStoredProfileValue,
  getCipherKitSecretKey,
  isCipherKitEncryptedValue,
} from '../../src/utils/profileCrypto';
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

test('persists exact cents and immutable evidence across requests and independent database handles', async () => {
  const created = await quote();
  expect(created).toMatchObject({
    currency: 'USD',
    subtotalCents: 87,
    shippingCents: 113,
    totalCents: 200,
    status: 'valid',
    address: { line1: '10 Main Street', zip: '98101', country: 'US' },
    lines: [
      {
        unitAmountCents: 29,
        totalAmountCents: 87,
        quantity: 3,
        filamentId,
        color: 'Black',
      },
    ],
  });
  state.db = drizzle(client, { schema });
  expect(await (await request(created.id)).json()).toEqual(created);
  expect(await db.select().from(schema.checkoutQuotes)).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).items).toEqual([
    {
      type: 'PRINT',
      publicFileServiceId: 'print-file',
      filamentId,
      quantity: 3,
    },
  ]);
});
test('rejects client prices, addresses and sales channels', async () => {
  for (const body of [
    { totalCents: 1 },
    { address: {} },
    { channel: 'in-person' },
  ])
    expect((await request(undefined, body)).status).toBe(400);
  expect(await db.select().from(schema.checkoutQuotes)).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
});
test('requires session and hides carts and quotes from another user', async () => {
  const created = await quote();
  state.userId = '';
  expect((await request()).status).toBe(401);
  state.userId = 'intruder';
  expect((await request()).status).toBe(404);
  expect((await request(created.id)).status).toBe(404);
});
test.each([
  'quantity',
  'price',
  'address',
  'file',
  'material',
  'availability',
  'delete',
  'ownership',
])('invalidates after %s changes without rewriting the snapshot', async change => {
  const created = await quote();
  if (change === 'quantity')
    await db
      .update(schema.cart)
      .set({ quantity: 4 })
      .where(eq(schema.cart.id, 1));
  if (change === 'price')
    await db
      .update(schema.productsTable)
      .set({ price: 1.99 })
      .where(eq(schema.productsTable.id, 1));
  if (change === 'address')
    await db
      .update(schema.users)
      .set({ shippingAddress: '20 Other Street' })
      .where(eq(schema.users.id, 'owner'));
  if (change === 'file')
    await db
      .update(schema.productsTable)
      .set({ publicFileServiceId: null })
      .where(eq(schema.productsTable.id, 1));
  if (change === 'material')
    await db
      .update(schema.productsTable)
      .set({ filamentType: 'PETG' })
      .where(eq(schema.productsTable.id, 1));
  if (change === 'availability')
    env.COLOR_CACHE = {
      get: async () => JSON.stringify({ success: true, data: [] }),
    } as unknown as KVNamespace;
  if (change === 'delete')
    await db.delete(schema.cart).where(eq(schema.cart.id, 1));
  if (change === 'ownership')
    await db
      .update(schema.shoppingCarts)
      .set({ userId: null })
      .where(eq(schema.shoppingCarts.id, cartId));
  expect(await (await request(created.id)).json()).toEqual({
    ...created,
    status: 'stale',
  });
  const [stored] = await db.select().from(schema.checkoutQuotes);
  expect(stored.invalidated).toBe(true);
  expect(isCipherKitEncryptedValue(stored.encryptedSnapshot)).toBe(true);
  const decrypted = await decryptStoredProfileValue(
    stored.encryptedSnapshot,
    await getCipherKitSecretKey(env.ENCRYPTION_PASSPHRASE),
  );
  expect(JSON.parse(decrypted ?? '')).toEqual(
    quoteSnapshotSchema.parse(created),
  );
});
test('expires at the documented boundary without estimating again', async () => {
  const created = await quote();
  vi.useFakeTimers();
  vi.setSystemTime(created.expiresAt);
  expect(await (await request(created.id)).json()).toEqual({
    ...created,
    status: 'expired',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
test.each([
  0, -1, 70, 1.5,
])('rejects invalid stored quantity %s', async quantity => {
  await db.update(schema.cart).set({ quantity }).where(eq(schema.cart.id, 1));
  expect((await request()).status).toBe(409);
  expect(fetchMock).not.toHaveBeenCalled();
});
test.each([
  0,
  -1,
  1.001,
  Number.MAX_SAFE_INTEGER,
])('rejects invalid Online Price %s', async price => {
  await db
    .update(schema.productsTable)
    .set({ price })
    .where(eq(schema.productsTable.id, 1));
  expect((await request()).status).toBe(409);
});
test('does not persist provider failures or fractional shipping cents', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('private error', { status: 500 }))
    .mockResolvedValueOnce(
      Response.json({ data: { totals: { deliveryCost: 1.001 } } }),
    );
  expect((await request()).status).toBe(502);
  expect((await request()).status).toBe(502);
  expect(await db.select().from(schema.checkoutQuotes)).toHaveLength(0);
});
test('rechecks changes during shipping estimation before persistence', async () => {
  fetchMock.mockImplementationOnce(async () => {
    await db
      .update(schema.cart)
      .set({ quantity: 4 })
      .where(eq(schema.cart.id, 1));
    return Response.json({ data: { order: { deliveryCost: '1.13' } } });
  });
  expect((await request()).status).toBe(409);
  expect(await db.select().from(schema.checkoutQuotes)).toHaveLength(0);
});
test('concurrent reviews retain distinct owned immutable quote identities', async () => {
  const [first, second] = await Promise.all([quote(), quote()]);
  expect(first.id).not.toBe(second.id);
  expect(await db.select().from(schema.checkoutQuotes)).toHaveLength(2);
  await expect(
    db
      .insert(schema.checkoutQuotes)
      .values((await db.select().from(schema.checkoutQuotes))[0]),
  ).rejects.toThrow();
});
test('availability outage fails closed without marking evidence valid', async () => {
  const created = await quote();
  env.COLOR_CACHE = { get: async () => null } as unknown as KVNamespace;
  fetchMock.mockRejectedValue(new Error('offline'));
  expect((await request(created.id)).status).toBe(503);
});

test.each([
  'quantity',
  'material',
])('rejects %s edits while final availability verification is pending', async change => {
  let reads = 0;
  env.COLOR_CACHE = {
    get: async () => {
      reads++;
      if (reads === 2) {
        if (change === 'quantity')
          await db
            .update(schema.cart)
            .set({ quantity: 4 })
            .where(eq(schema.cart.id, 1));
        else
          await db
            .update(schema.productsTable)
            .set({ filamentType: 'PETG' })
            .where(eq(schema.productsTable.id, 1));
      }
      return JSON.stringify(availability);
    },
  } as unknown as KVNamespace;
  expect((await request()).status).toBe(409);
  expect(await db.select().from(schema.checkoutQuotes)).toHaveLength(0);
});
test('does not report validity after expiry during an availability read', async () => {
  const created = await quote();
  env.COLOR_CACHE = {
    get: async () => {
      vi.spyOn(Date, 'now').mockReturnValue(created.expiresAt);
      return JSON.stringify(availability);
    },
  } as unknown as KVNamespace;
  expect(await (await request(created.id)).json()).toMatchObject({
    status: 'expired',
  });
  vi.restoreAllMocks();
});
test('concurrent permanent invalidation wins over a pending validation', async () => {
  const created = await quote();
  env.COLOR_CACHE = {
    get: async () => {
      await db
        .update(schema.checkoutQuotes)
        .set({ invalidated: true })
        .where(eq(schema.checkoutQuotes.id, created.id));
      return JSON.stringify(availability);
    },
  } as unknown as KVNamespace;
  expect(await (await request(created.id)).json()).toMatchObject({
    status: 'stale',
  });
});

test('In-Person Price and Square publication changes cannot reprice an Online quote', async () => {
  const created = await quote();
  await db
    .update(schema.productsTable)
    .set({ inPersonPrice: 9999, squareRevision: 1 })
    .where(eq(schema.productsTable.id, 1));
  expect(await (await request(created.id)).json()).toEqual(created);
  await db
    .update(schema.productsTable)
    .set({ price: 1.99, squareRevision: 2 })
    .where(eq(schema.productsTable.id, 1));
  expect(await (await request(created.id)).json()).toEqual({
    ...created,
    status: 'stale',
  });
});
