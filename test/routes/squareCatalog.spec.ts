import { env } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import initialSchema from '../../drizzle/migrations/0000_normal_captain_flint.sql';
import organizationSchema from '../../drizzle/migrations/0001_jittery_peter_parker.sql';
import orderSchema from '../../drizzle/migrations/0005_salty_thunderbolt_ross.sql';
import fulfillmentSchema from '../../drizzle/migrations/0006_add_stripe_fulfillment.sql';
import publicationMigration from '../../drizzle/migrations/0011_square_catalog.sql';
import {
  categoryTable,
  memberTable,
  organizationTable,
  productsTable,
  productsToCategories,
  squareCatalogMappings,
  squareCatalogOperations,
  uploadedFilesTable,
  users,
} from '../../src/db/schema';
import app from '../../src/index';
import type { Bindings } from '../../src/types';
import { mockBetterAuth } from '../mocks/auth';
import { mockEnv } from '../mocks/env';

vi.unmock('drizzle-orm/d1');
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
  }
}
const db = drizzle(env.DB);
const legacyProducts = sqliteTable('products', {
  id: integer('id').primaryKey(),
  name: text('name'),
  description: text('description'),
  stl: text('stl'),
  price: real('price'),
  filamentType: text('filament_type'),
  skuNumber: text('sku_number'),
  color: text('color'),
  publicFileServiceId: text('public_file_service_id'),
  stripeProductId: text('stripe_product_id'),
  stripePriceId: text('stripe_price_id'),
});
const storedItem = () =>
  db.select().from(productsTable).where(eq(productsTable.id, 1)).get();
const bindings: Bindings = {
  ...mockEnv(),
  DB: env.DB,
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_ACCESS_TOKEN: 'secret-do-not-return',
  SQUARE_MERCHANT_ID: 'merchant',
  SQUARE_LOCATION_ID: 'location',
};
const update = {
  id: 1,
  name: 'Bracket',
  description: 'A bracket',
  price: 19.95,
  filamentType: 'PLA',
  color: '#000000',
  image: '',
};
const request = (
  path: string,
  method = 'GET',
  body?: unknown,
  config = bindings,
) =>
  app.request(
    path,
    {
      method,
      headers: { Cookie: 'session=test', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    config,
  );
const publish = () => request('/admin/catalog/1/square/publish', 'POST');
const unpublish = () => request('/admin/catalog/1/square/unpublish', 'POST');
const statusSchema = z.object({
  status: z.enum(['unpublished', 'published', 'needs_update']),
  price: z.number(),
  inPersonPrice: z.number().nullable(),
  mapping: z
    .object({
      itemId: z.string().nullable(),
      variationId: z.string().nullable(),
    })
    .passthrough()
    .nullable(),
  pendingOperation: z
    .object({ id: z.string(), kind: z.enum(['publish', 'unpublish']) })
    .passthrough()
    .nullable(),
  error: z.string().nullable(),
});
const status = async () =>
  statusSchema.parse(await (await request('/admin/catalog/1/square')).json());
type VariationFixture = {
  id: string;
  type: string;
  version?: number;
  item_variation_data: {
    item_id: string;
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
type ItemFixture = {
  id: string;
  type: string;
  version?: number;
  item_data: { variations: VariationFixture[]; [key: string]: unknown };
  [key: string]: unknown;
};
const sent: Array<{ idempotency_key: string; object: ItemFixture }> = [];
let remote: ItemFixture | undefined;
let nextWrite:
  | ((payload: (typeof sent)[number]) => Promise<Response>)
  | undefined;
function remoteItem(): ItemFixture {
  if (!remote) throw new Error('Expected a published Square Item');
  return remote;
}
function success(payload: (typeof sent)[number]) {
  remote = structuredClone(payload.object);
  remote.id = 'square-item';
  remote.version = (remote.version ?? 0) + 1;
  remote.item_data.variations = remote.item_data.variations.map(
    (v: VariationFixture) => ({
      ...v,
      id: v.id.startsWith('#') ? 'square-variation' : v.id,
      version: remoteItem().version,
      item_variation_data: { ...v.item_variation_data, item_id: 'square-item' },
    }),
  );
  return Response.json({ catalog_object: remote });
}
async function squareFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  expect(url.startsWith('https://connect.squareupsandbox.com/v2/')).toBe(true);
  expect(new Headers(init?.headers).get('Square-Version')).toBe('2026-08-19');
  if (url.includes('/locations/'))
    return Response.json({
      location: {
        id: 'location',
        merchant_id: 'merchant',
        currency: 'USD',
        status: 'ACTIVE',
      },
    });
  if (init?.method === 'GET') return Response.json({ catalog_object: remote });
  const payload: { idempotency_key: string; object: ItemFixture } = JSON.parse(
    String(init?.body),
  );
  sent.push(payload);
  const handler = nextWrite;
  nextWrite = undefined;
  return handler ? handler(payload) : success(payload);
}
beforeAll(async () => {
  // Exercise the generated migration against the last recorded Drizzle snapshot (0006).
  for (const source of [
    initialSchema,
    organizationSchema,
    orderSchema,
    fulfillmentSchema,
  ]) {
    for (const statement of source
      .split('--> statement-breakpoint')
      .filter(s => s.trim()))
      await db.run(sql.raw(statement));
  }
  await db.insert(legacyProducts).values({
    id: 1,
    name: 'Bracket',
    description: 'A bracket',
    stl: 'file-123',
    price: 19.95,
    filamentType: 'PLA',
    skuNumber: 'BRACKET',
    color: '#000000',
    publicFileServiceId: 'file-123',
    stripeProductId: 'old-product',
    stripePriceId: 'old-price',
  });
  await db
    .insert(users)
    .values({ id: 'user_123', name: 'Admin', email: 'admin@example.com' });
  await db
    .insert(categoryTable)
    .values({ categoryId: 1, categoryName: 'Parts' });
  await db.insert(productsToCategories).values({ productId: 1, categoryId: 1 });
  await db.insert(uploadedFilesTable).values({
    publicFileServiceId: 'file-123',
    fileName: 'bracket.stl',
    fileURL: 'durable-reference',
  });
  for (const statement of publicationMigration
    .split('--> statement-breakpoint')
    .filter(s => s.trim()))
    await db.run(sql.raw(statement));
  // Prime membership before concurrent HTTP requests; authorization still uses the real DB.
  await db.insert(organizationTable).values({
    id: 'org_shared_catalog',
    name: 'Catalog',
    slug: 'catalog',
    createdAt: new Date(0),
  });
  await db.insert(memberTable).values({
    id: 'admin',
    organizationId: 'org_shared_catalog',
    userId: 'user_123',
    role: 'admin',
    createdAt: new Date(0),
  });
});
beforeEach(() => {
  sent.length = 0;
  remote = undefined;
  nextWrite = undefined;
  mockBetterAuth.getSession.mockImplementation(async () => ({
    session: { id: 'session', expiresAt: new Date(Date.now() + 10000) },
    user: {
      id: 'user_123',
      name: 'Admin',
      email: 'admin@example.com',
      role: 'admin',
    },
  }));
  vi.mocked(fetch).mockReset().mockImplementation(squareFetch);
});
async function setPrice(value: number | null = 12.34) {
  const response = await request('/update-product', 'PUT', {
    ...update,
    inPersonPrice: value,
  });
  expect(response.status).toBe(200);
}

describe('Square catalog HTTP with real isolated D1', () => {
  test.each([
    '0',
    '-1',
    '1.5',
    'invalid',
    '9007199254740992',
  ])('rejects invalid catalog ID %s', async id => {
    const response = await request(`/admin/catalog/${id}/square`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_catalog_id' });
    expect(fetch).not.toHaveBeenCalled();
  });
  test('forward migration preserves products, category links, users and Print Files', async () => {
    expect(await storedItem()).toMatchObject({
      name: 'Bracket',
      price: 19.95,
      inPersonPrice: null,
      publicFileServiceId: 'file-123',
      stripePriceId: 'old-price',
    });
    expect(await storedItem()).not.toHaveProperty('stripeProductId');
    for (const table of [
      users,
      categoryTable,
      productsToCategories,
      uploadedFilesTable,
    ])
      expect(await db.select().from(table)).toHaveLength(1);
    expect(await status()).toMatchObject({
      status: 'unpublished',
      mapping: null,
      inPersonPrice: null,
    });
  });
  test.each([
    0,
    -1,
    1.001,
    1.0000000000000002,
    100000000,
    '12.34',
  ])('rejects invalid in-person amount %s', async value => {
    expect(
      (
        await request('/update-product', 'PUT', {
          ...update,
          inPersonPrice: value,
        })
      ).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('prices remain distinct, cents are exact, omitted price survives updates, reads use USD', async () => {
    await setPrice(0.29);
    expect((await storedItem())?.inPersonPrice).toBe(29);
    expect((await request('/update-product', 'PUT', update)).status).toBe(200);
    expect(await status()).toMatchObject({ price: 19.95, inPersonPrice: 0.29 });
    // Avoid optional Slant hydration in the generic read route for this assertion.
    await db
      .update(productsTable)
      .set({ publicFileServiceId: null })
      .where(eq(productsTable.id, 1));
    expect(await (await request('/product/1')).json()).toMatchObject({
      inPersonPrice: 0.29,
      price: 19.95,
    });
    expect(await (await request('/products')).json()).toEqual([
      expect.objectContaining({ inPersonPrice: 0.29 }),
    ]);
  }, 15000);
  test('publication requires an explicit price and configuration', async () => {
    expect((await publish()).status).toBe(400);
    expect(
      (
        await request('/admin/catalog/1/square/publish', 'POST', undefined, {
          ...bindings,
          SQUARE_ENVIRONMENT: undefined,
        })
      ).status,
    ).toBe(503);
    expect(sent).toHaveLength(0);
  });
  test.each([
    'GET',
    'POST',
  ])('denies non-admin %s and unauthenticated calls', async method => {
    await db.update(memberTable).set({ role: 'member' });
    const path = `/admin/catalog/1/square${method === 'GET' ? '' : '/publish'}`;
    expect((await request(path, method)).status).toBe(403);
    expect(
      (await request('/admin/catalog/1/square/unpublish', 'POST')).status,
    ).toBe(403);
    expect(
      (await request('/update-product', 'PUT', { ...update, inPersonPrice: 1 }))
        .status,
    ).toBe(403);
    mockBetterAuth.getSession.mockResolvedValue(null);
    expect((await request(path, method)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('publish, refresh, archive, republish retain mappings and unrelated remote fields', async () => {
    await setPrice();
    expect((await publish()).status).toBe(200);
    expect(sent[0].object).toMatchObject({
      type: 'ITEM',
      present_at_all_locations: false,
      present_at_location_ids: ['location'],
      item_data: {
        name: 'Bracket',
        description: 'A bracket',
        variations: [
          {
            item_variation_data: {
              sku: 'BRACKET',
              price_money: { amount: 1234, currency: 'USD' },
              pricing_type: 'FIXED_PRICING',
              track_inventory: false,
            },
          },
        ],
      },
    });
    const mapping = (await status()).mapping;
    remoteItem().item_data.tax_ids = ['tax'];
    remoteItem().custom_attribute_values = {
      external: { string_value: 'keep' },
    };
    remoteItem().item_data.variations.push({
      id: 'external-variation',
      type: 'ITEM_VARIATION',
      version: 1,
      item_variation_data: { item_id: 'square-item', name: 'Keep' },
    });
    await setPrice(22.5);
    expect(await status()).toMatchObject({ status: 'needs_update' });
    expect((await publish()).status).toBe(200);
    expect(sent[1].object).toMatchObject({
      version: 1,
      custom_attribute_values: { external: { string_value: 'keep' } },
      item_data: {
        tax_ids: ['tax'],
        variations: [
          expect.objectContaining({ version: 1 }),
          expect.objectContaining({ id: 'external-variation' }),
        ],
      },
    });
    expect((await unpublish()).status).toBe(200);
    expect(await status()).toMatchObject({ status: 'unpublished', mapping });
    expect(remoteItem().item_data.is_archived).toBe(true);
    expect((await publish()).status).toBe(200);
    expect(await status()).toMatchObject({ status: 'published', mapping });
    expect(remoteItem().item_data.is_archived).toBe(false);
    expect((await storedItem())?.publicFileServiceId).toBe('file-123');
  });
  test('unknown result replays exact persisted payload/key before newer edits or opposite operation', async () => {
    await setPrice();
    nextWrite = async payload => {
      success(payload);
      throw new Error('secret-do-not-return');
    };
    expect((await publish()).status).toBe(502);
    expect(await status()).toMatchObject({
      error: 'square_outcome_unknown',
      pendingOperation: { kind: 'publish' },
    });
    const saved = await db
      .select()
      .from(squareCatalogOperations)
      .where(eq(squareCatalogOperations.state, 'pending'))
      .get();
    expect(JSON.parse(String(saved?.payload))).toEqual(sent[0]);
    await setPrice(15);
    expect((await unpublish()).status).toBe(200);
    expect(sent[1]).toEqual(sent[0]);
    expect(await status()).toMatchObject({
      status: 'needs_update',
      pendingOperation: null,
    });
    expect((await unpublish()).status).toBe(200);
    expect(await status()).toMatchObject({ status: 'unpublished' });
  });
  test('concurrent prepares share one durable operation and cannot create duplicate offerings', async () => {
    await setPrice();
    const results = await Promise.all([publish(), publish(), publish()]);
    expect(results.every(r => [200, 409].includes(r.status))).toBe(true);
    expect(new Set(sent.map(p => p.idempotency_key)).size).toBe(1);
    expect(await db.select().from(squareCatalogMappings)).toHaveLength(1);
    expect(await status()).toMatchObject({
      status: 'published',
      pendingOperation: null,
    });
  });
  test('edits during publication cannot be marked published by its older response', async () => {
    await setPrice();
    nextWrite = async payload => {
      await request('/update-product', 'PUT', {
        ...update,
        name: 'New name',
        inPersonPrice: 18,
      });
      return success(payload);
    };
    expect((await publish()).status).toBe(200);
    expect(await status()).toMatchObject({
      status: 'needs_update',
      inPersonPrice: 18,
    });
  });
  test('pending and published guards are atomic; archive permits clearing/deletion and retains history', async () => {
    await setPrice();
    nextWrite = async payload => {
      expect((await request('/delete-product/1', 'DELETE')).status).toBe(409);
      expect(
        (
          await request('/update-product', 'PUT', {
            ...update,
            inPersonPrice: null,
            categoryIds: [1],
          })
        ).status,
      ).toBe(409);
      return success(payload);
    };
    expect((await publish()).status).toBe(200);
    expect((await request('/delete-product/1', 'DELETE')).status).toBe(409);
    expect((await unpublish()).status).toBe(200);
    await setPrice(null);
    expect((await request('/delete-product/1', 'DELETE')).status).toBe(200);
    expect(await db.select().from(squareCatalogMappings).get()).toMatchObject({
      productId: null,
      catalogId: 1,
      itemId: 'square-item',
      variationId: 'square-variation',
      published: 0,
    });
  });
  test('version conflicts are visible and a new explicit retry retrieves current versions', async () => {
    await setPrice();
    await publish();
    nextWrite = async () =>
      Response.json(
        { errors: [{ detail: 'secret-do-not-return' }] },
        { status: 409 },
      );
    expect((await publish()).status).toBe(502);
    expect(await status()).toMatchObject({
      error: 'square_version_conflict',
      pendingOperation: null,
    });
    remoteItem().version = 8;
    remoteItem().item_data.variations[0].version = 8;
    expect((await publish()).status).toBe(200);
    expect(sent[2].object.version).toBe(8);
    expect(sent[2].idempotency_key).not.toBe(sent[1].idempotency_key);
  });
  test('mapping scope and merchant/location/USD validation prevent cross-environment writes', async () => {
    await setPrice();
    await publish();
    vi.mocked(fetch).mockClear();
    expect(
      (
        await request('/admin/catalog/1/square/publish', 'POST', undefined, {
          ...bindings,
          SQUARE_ENVIRONMENT: 'production',
        })
      ).status,
    ).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        location: {
          id: 'location',
          merchant_id: 'wrong',
          currency: 'USD',
          status: 'ACTIVE',
        },
      }),
    );
    expect((await publish()).status).toBe(502);
    expect(await status()).toMatchObject({ error: 'square_location_mismatch' });
  });
  test.each([
    '/add-product',
    '/v2/add-product',
  ])('creation %s retains markup and never creates Stripe catalog objects', async path => {
    vi.mocked(fetch).mockImplementation(async input => {
      expect(String(input)).toMatch(/slant3d.*(?:estimate|slicer)/);
      return Response.json({ data: { total: 10, price: 10 } });
    });
    const response = await request(path, 'POST', {
      name: 'New part',
      description: 'New',
      image: '',
      filamentType: 'PLA',
      color: '#000000',
      stl: 'file-new',
      publicFileServiceId: 'file-new',
      price: 25,
      inPersonPrice: 2.29,
    });
    expect([200, 201]).toContain(response.status);
    expect(
      await db
        .select()
        .from(productsTable)
        .where(eq(productsTable.name, 'New part'))
        .get(),
    ).toMatchObject({
      price: 12.5,
      inPersonPrice: 229,
      stripePriceId: null,
    });
    expect(await db.select().from(squareCatalogMappings)).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test('an owner can publish and Online Price-only edits keep published status', async () => {
    await db.update(memberTable).set({ role: 'owner' });
    await setPrice();
    expect((await publish()).status).toBe(200);
    expect(
      (await request('/update-product', 'PUT', { ...update, price: 25 }))
        .status,
    ).toBe(200);
    expect(await status()).toMatchObject({ status: 'published', price: 25 });
  });
  test.each([
    408, 429, 500, 502,
  ])('HTTP %s preserves the same unresolved key', async code => {
    await setPrice();
    nextWrite = async () =>
      Response.json(
        { errors: [{ detail: 'secret-do-not-return' }] },
        { status: code },
      );
    expect((await publish()).status).toBe(502);
    expect(await status()).toMatchObject({
      pendingOperation: { kind: 'publish' },
    });
    expect((await publish()).status).toBe(200);
    expect(sent[1]).toEqual(sent[0]);
  });
  test('malformed successful responses remain uncertain and sanitized', async () => {
    await setPrice();
    nextWrite = async () => Response.json({ token: 'secret-do-not-return' });
    const response = await publish();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret-do-not-return');
    expect(await status()).toMatchObject({
      error: 'square_invalid_response',
      pendingOperation: { kind: 'publish' },
    });
    expect((await publish()).status).toBe(200);
    expect(sent[1]).toEqual(sent[0]);
  });
  test.each([
    [
      'deleted variation',
      (variation: VariationFixture) => {
        variation.is_deleted = true;
      },
    ],
    [
      'missing version',
      (variation: VariationFixture) => {
        delete variation.version;
      },
    ],
    [
      'missing price',
      (variation: VariationFixture) => {
        delete variation.item_variation_data.price_money;
      },
    ],
    [
      'wrong currency',
      (variation: VariationFixture) => {
        variation.item_variation_data.price_money = {
          amount: 1234,
          currency: 'CAD',
        };
      },
    ],
    [
      'wrong amount',
      (variation: VariationFixture) => {
        variation.item_variation_data.price_money = {
          amount: 1235,
          currency: 'USD',
        };
      },
    ],
    [
      'variable pricing',
      (variation: VariationFixture) => {
        variation.item_variation_data.pricing_type = 'VARIABLE_PRICING';
      },
    ],
  ] as const)('a response with %s stays pending instead of falsely confirming publication', async (_name, corrupt) => {
    await setPrice();
    nextWrite = async payload => {
      success(payload);
      corrupt(remoteItem().item_data.variations[0]);
      return Response.json({ catalog_object: remoteItem() });
    };
    expect((await publish()).status).toBe(502);
    expect(await status()).toMatchObject({
      status: 'unpublished',
      pendingOperation: { kind: 'publish' },
    });
    expect((await publish()).status).toBe(200);
    expect(sent[1]).toEqual(sent[0]);
  });
  test('a rejection after an uncertain attempt never allocates a new listing key', async () => {
    await setPrice();
    nextWrite = async payload => {
      success(payload);
      throw new Error('transport lost');
    };
    await publish();
    nextWrite = async () => Response.json({}, { status: 400 });
    expect((await publish()).status).toBe(502);
    expect(await status()).toMatchObject({
      pendingOperation: { kind: 'publish' },
    });
    expect((await publish()).status).toBe(200);
    expect(sent[2]).toEqual(sent[0]);
  });
  test('delayed replay completion cannot overwrite a newer archive', async () => {
    await setPrice();
    let started: () => void = () => {};
    const didStart = new Promise<void>(resolve => {
      started = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    nextWrite = async payload => {
      const response = success(payload);
      started();
      await released;
      return response;
    };
    const oldRequest = publish();
    await didStart;
    try {
      expect((await publish()).status).toBe(200);
      expect((await unpublish()).status).toBe(200);
    } finally {
      release();
    }
    expect((await oldRequest).status).toBe(200);
    expect(await status()).toMatchObject({
      status: 'unpublished',
      pendingOperation: null,
    });
  });
  test('a local deletion during remote retrieval prevents reservation and remote write', async () => {
    await setPrice();
    await publish();
    await unpublish();
    sent.length = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (
        String(input).includes('/catalog/object/') &&
        init?.method === 'GET'
      ) {
        expect((await request('/delete-product/1', 'DELETE')).status).toBe(200);
      }
      return squareFetch(input, init);
    });
    expect((await publish()).status).toBe(409);
    expect(sent).toHaveLength(0);
    expect(
      await db
        .select()
        .from(squareCatalogOperations)
        .where(eq(squareCatalogOperations.state, 'pending')),
    ).toHaveLength(0);
  });
  test('an unresolved archive guards deletion and retains the archived IDs on retry', async () => {
    await setPrice();
    await publish();
    nextWrite = async payload => {
      success(payload);
      throw new Error('archive response lost');
    };
    expect((await unpublish()).status).toBe(502);
    expect((await request('/delete-product/1', 'DELETE')).status).toBe(409);
    expect((await unpublish()).status).toBe(200);
    expect(sent[2]).toEqual(sent[1]);
    expect(await status()).toMatchObject({ status: 'unpublished' });
  });
  test.each([
    {
      id: 'location',
      merchant_id: 'merchant',
      currency: 'CAD',
      status: 'ACTIVE',
    },
    {
      id: 'location',
      merchant_id: 'merchant',
      currency: 'USD',
      status: 'INACTIVE',
    },
    { id: 'other', merchant_id: 'merchant', currency: 'USD', status: 'ACTIVE' },
  ])('rejects invalid configured location data %j', async location => {
    await setPrice();
    vi.mocked(fetch).mockResolvedValue(Response.json({ location }));
    expect((await publish()).status).toBe(502);
    expect(sent).toHaveLength(0);
  });
  test('OpenAPI exposes publication routes and the in-person input contract', async () => {
    const response = await request('/open-api');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('/admin/catalog/{id}/square');
    expect(text).toContain('inPersonPrice');
    expect(text).toContain('needs_update');
  });
});
