import { SQL, sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  memberTable,
  organizationTable,
  productsTable,
  squareCatalogMappings,
  squareCatalogOperations,
} from '../../src/db/schema';
import app from '../../src/index';
import {
  priceToCents,
  productPrices,
} from '../../src/modules/catalogPublication';
import { mockBetterAuth } from '../mocks/auth';
import { mockEnv } from '../mocks/env';

const storage = vi.hoisted(() => ({
  read: vi.fn<(table: unknown) => unknown>(),
  returning: vi.fn<() => unknown[]>(),
  insert: vi.fn(),
  set: vi.fn(),
  filter: vi.fn(),
  batch: vi.fn(),
}));

// Script query results at the Drizzle boundary. No database, migration, or storage binding is used.
// These tests exercise HTTP/application behavior, not database atomicity.
vi.mock('drizzle-orm/d1', () => {
  const query = (table?: unknown, fields?: Record<string, unknown>) => ({
    fields,
    from(next: unknown) {
      return query(next, fields);
    },
    where(condition: SQL) {
      storage.filter(table, fields, condition);
      return query(table, fields);
    },
    innerJoin() {
      return query(table, fields);
    },
    get: async () => storage.read(table),
    getSQL: () => sql``,
    returning: async () => storage.returning(),
    run: async () => undefined,
    onConflictDoNothing() {
      return query(table, fields);
    },
  });
  return {
    drizzle: vi.fn(() => ({
      select: (fields?: Record<string, unknown>) => query(undefined, fields),
      insert: (table: unknown) => ({
        select: (selection: ReturnType<typeof query>) => {
          storage.insert(table, selection.fields);
          return query(table);
        },
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          storage.set(table, values);
          return query(table, values);
        },
      }),
      delete: (table: unknown) => query(table),
      batch: storage.batch,
    })),
  };
});

const bindings = {
  ...mockEnv(),
  SQUARE_ENVIRONMENT: 'sandbox' as const,
  SQUARE_ACCESS_TOKEN: 'secret-do-not-return',
  SQUARE_MERCHANT_ID: 'merchant',
  SQUARE_LOCATION_ID: 'location',
};
const snapshot = JSON.stringify({
  name: 'Bracket',
  description: 'A bracket',
  sku: 'BRACKET',
  material: 'PLA',
  color: '#000000',
  cents: 1234,
});
const item = {
  id: 1,
  name: 'Bracket',
  description: 'A bracket',
  price: 19.95,
  inPersonPrice: 1234,
  skuNumber: 'BRACKET',
  filamentType: 'PLA',
  color: '#000000',
  squareRevision: 0,
};
const mapping = {
  id: 'mapping',
  productId: 1,
  catalogId: 1,
  environment: 'sandbox',
  merchantId: 'merchant',
  locationId: 'location',
  itemId: 'square-item',
  variationId: 'square-variation',
  published: 1,
  publishedSnapshot: snapshot,
  generation: 1,
  error: null,
};
const remote = () => ({
  type: 'ITEM',
  id: 'square-item',
  version: 7,
  custom_attribute_values: { seller: { string_value: 'keep' } },
  item_data: {
    name: 'Bracket',
    description: 'A bracket',
    is_archived: false,
    variations: [
      {
        type: 'ITEM_VARIATION',
        id: 'square-variation',
        version: 6,
        item_variation_data: {
          item_id: 'square-item',
          name: 'In-Person · PLA · #000000',
          sku: 'BRACKET',
          pricing_type: 'FIXED_PRICING',
          price_money: { amount: 1234, currency: 'USD' },
        },
      },
    ],
  },
});
const pending = {
  id: 'saved-key',
  mappingId: 'mapping',
  kind: 'publish',
  state: 'pending',
  payload: JSON.stringify({ idempotency_key: 'saved-key', object: remote() }),
  snapshot,
  generation: 1,
  error: 'square_outcome_unknown',
  createdAt: '2026-09-13',
};
let rows: Map<unknown, unknown>;
const request = (action = '', id = '1', config = bindings) =>
  app.request(
    `/admin/catalog/${id}/square${action ? `/${action}` : ''}`,
    { method: action ? 'POST' : 'GET', headers: { Cookie: 'session=test' } },
    config,
  );
const writes = () =>
  vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
const readField = (fields: Record<string, unknown>, key: string) => {
  const value = fields[key];
  if (!(value instanceof SQL)) {
    // Fields below are parameterized SQL values produced by the real publication module.
    throw new Error(`Expected parameterized field ${key}`);
  }
  return new SQLiteSyncDialect().sqlToQuery(value).params[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  rows = new Map<unknown, unknown>([
    [organizationTable, { id: 'org_shared_catalog' }],
    [memberTable, { id: 'member', role: 'admin' }],
    [productsTable, { ...item }],
    [squareCatalogMappings, { ...mapping }],
    [squareCatalogOperations, undefined],
  ]);
  storage.read.mockReset().mockImplementation(table => rows.get(table));
  storage.returning.mockReset().mockReturnValue([{ id: 'saved-key' }]);
  storage.insert.mockReset();
  storage.batch.mockReset().mockResolvedValue([]);
  mockBetterAuth.getSession.mockReset().mockResolvedValue({
    session: { id: 'session', expiresAt: new Date(Date.now() + 10000) },
    user: {
      id: 'user_123',
      name: 'Admin',
      email: 'admin@example.com',
      role: 'admin',
    },
  });
  vi.mocked(fetch)
    .mockReset()
    .mockImplementation(async (input, init) => {
      const url = String(input);
      expect(url.startsWith('https://connect.squareupsandbox.com/v2/')).toBe(
        true,
      );
      expect(new Headers(init?.headers).get('Square-Version')).toBe(
        '2026-08-19',
      );
      if (url.endsWith('/locations/location'))
        return Response.json({
          location: {
            id: 'location',
            merchant_id: 'merchant',
            currency: 'USD',
            status: 'ACTIVE',
          },
        });
      if (url.endsWith('/catalog/object/square-item') && init?.method === 'GET')
        return Response.json({ catalog_object: remote() });
      if (url.endsWith('/catalog/object') && init?.method === 'POST')
        return Response.json({ catalog_object: remote() });
      throw new Error(`Unexpected mocked request: ${url}`);
    });
});

describe('Square catalog HTTP with mocked Drizzle and fetch', () => {
  test.each([
    '0',
    '-1',
    '1.5',
    'invalid',
    '9007199254740992',
  ])('rejects invalid ID %s', async id => {
    const response = await request('', id);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_catalog_id' });
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each([
    '',
    'publish',
    'unpublish',
  ])('requires authentication for %s', async action => {
    mockBetterAuth.getSession.mockResolvedValue(null);
    expect((await request(action)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each([
    '',
    'publish',
    'unpublish',
  ])('rejects non-admin membership for %s', async action => {
    rows.set(memberTable, { role: 'member' });
    expect((await request(action)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each([
    'admin',
    'owner',
  ])('allows %s to inspect prices and stable identifiers', async role => {
    rows.set(memberTable, { role });
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      price: 19.95,
      inPersonPrice: 12.34,
      status: 'published',
      mapping: { itemId: 'square-item', variationId: 'square-variation' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  test('a priced product without a Square mapping is unpublished', async () => {
    rows.set(squareCatalogMappings, undefined);
    expect(await (await request()).json()).toMatchObject({
      status: 'unpublished',
      mapping: null,
      price: 19.95,
      inPersonPrice: 12.34,
    });
  });
  test('local details change status while an Online Price-only edit does not', async () => {
    rows.set(productsTable, { ...item, price: 40 });
    expect(await (await request()).json()).toMatchObject({
      status: 'published',
      price: 40,
    });
    rows.set(productsTable, { ...item, name: 'New name' });
    expect(await (await request()).json()).toMatchObject({
      status: 'needs_update',
    });
  });
  test('missing catalog item is 404', async () => {
    rows.set(productsTable, undefined);
    expect((await request('publish')).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('missing configuration is sanitized', async () => {
    const response = await request('publish', '1', {
      ...bindings,
      SQUARE_ACCESS_TOKEN: '',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'square_configuration_required',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each([
    'environment',
    'merchantId',
    'locationId',
  ])('rejects mapping contamination in %s', async key => {
    rows.set(squareCatalogMappings, { ...mapping, [key]: 'different' });
    expect((await request('publish')).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each([
    'publish',
    'unpublish',
  ])('replays saved payload before requested %s or newer edits', async action => {
    rows.set(squareCatalogOperations, pending);
    rows.set(productsTable, {
      ...item,
      name: 'Newer local edit',
      inPersonPrice: 2900,
    });
    expect((await request(action)).status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.[1]?.body).toBe(pending.payload);
    expect(storage.insert).not.toHaveBeenCalled();
    expect(storage.set).toHaveBeenCalledWith(
      squareCatalogMappings,
      expect.objectContaining({
        publishedSnapshot: snapshot,
        itemId: 'square-item',
        variationId: 'square-variation',
      }),
    );
    expect(await (await request()).json()).toMatchObject({
      status: 'needs_update',
    });
  });
  test('an already resolved replay skips the remote write', async () => {
    rows.set(squareCatalogOperations, pending);
    storage.returning.mockReturnValue([]);
    expect((await request('publish')).status).toBe(200);
    expect(writes()).toHaveLength(0);
  });
  test.each([
    408, 429, 500, 502, 409,
  ])('replay HTTP %s errors remain sanitized and reuse the saved payload', async code => {
    rows.set(squareCatalogOperations, pending);
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          location: {
            id: 'location',
            merchant_id: 'merchant',
            currency: 'USD',
            status: 'ACTIVE',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('secret-do-not-return', { status: code }),
      );
    const response = await request('publish');
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret-do-not-return');
    expect((await request('publish')).status).toBe(200);
    expect(writes().map(([, init]) => init?.body)).toEqual([
      pending.payload,
      pending.payload,
    ]);
    expect(storage.insert).not.toHaveBeenCalled();
  });
  test('malformed successful response cannot confirm publication', async () => {
    rows.set(squareCatalogOperations, pending);
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          location: {
            id: 'location',
            merchant_id: 'merchant',
            currency: 'USD',
            status: 'ACTIVE',
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ catalog_object: { token: 'secret-do-not-return' } }),
      );
    expect((await request('publish')).status).toBe(502);
    expect(storage.set).not.toHaveBeenCalledWith(squareCatalogOperations, {
      state: 'succeeded',
      error: null,
    });
  });
  test.each([
    'merchant_id',
    'currency',
    'status',
  ])('rejects invalid location %s', async key => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        location: {
          id: 'location',
          merchant_id: 'merchant',
          currency: 'USD',
          status: 'ACTIVE',
          [key]: 'invalid',
        },
      }),
    );
    expect((await request('publish')).status).toBe(502);
    expect(writes()).toHaveLength(0);
  });
  test.each([
    'publish',
    'unpublish',
  ])('prepares %s with current versions and preserved remote fields before dispatch', async action => {
    storage.returning.mockReturnValue([]);
    expect((await request(action)).status).toBe(409);
    expect(storage.insert).toHaveBeenCalledOnce();
    const fields: Record<string, unknown> = storage.insert.mock.calls[0]?.[1];
    const payload = readField(fields, 'payload');
    expect(typeof payload).toBe('string');
    if (typeof payload !== 'string') throw new Error('Expected saved payload');
    expect(JSON.parse(payload)).toMatchObject({
      object: {
        id: 'square-item',
        version: 7,
        custom_attribute_values: remote().custom_attribute_values,
        item_data: {
          is_archived: action === 'unpublish',
          variations: [{ id: 'square-variation', version: 6 }],
        },
      },
    });
    expect(writes()).toHaveLength(0);
  });
  test.each([
    'publish',
    'unpublish',
  ])('confirms a reserved %s using retained identifiers', async action => {
    const result = remote();
    result.item_data.is_archived = action === 'unpublish';
    storage.insert.mockImplementation(
      (table: unknown, fields: Record<string, unknown>) => {
        expect(table).toBe(squareCatalogOperations);
        storage.returning.mockReturnValueOnce([
          {
            ...pending,
            id: readField(fields, 'id'),
            kind: action,
            payload: readField(fields, 'payload'),
            snapshot: readField(fields, 'snapshot'),
            error: null,
          },
        ]);
      },
    );
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'POST') {
        expect(storage.insert).toHaveBeenCalledOnce();
        return Response.json({ catalog_object: result });
      }
      if (!defaultFetch) throw new Error('Expected mocked fetch');
      return defaultFetch(input, init);
    });
    expect((await request(action)).status).toBe(200);
    expect(storage.set).toHaveBeenCalledWith(
      squareCatalogMappings,
      expect.objectContaining({
        itemId: 'square-item',
        variationId: 'square-variation',
        published: action === 'publish' ? 1 : 0,
      }),
    );
    expect(storage.set).toHaveBeenCalledWith(squareCatalogOperations, {
      state: 'succeeded',
      error: null,
    });
    expect(storage.batch).toHaveBeenCalledOnce();
  });
  test.each([
    { is_deleted: true },
    { version: undefined },
    {
      item_variation_data: {
        ...remote().item_data.variations[0]?.item_variation_data,
        price_money: undefined,
      },
    },
    {
      item_variation_data: {
        ...remote().item_data.variations[0]?.item_variation_data,
        price_money: { amount: 1234, currency: 'CAD' },
      },
    },
    {
      item_variation_data: {
        ...remote().item_data.variations[0]?.item_variation_data,
        price_money: { amount: 1, currency: 'USD' },
      },
    },
    {
      item_variation_data: {
        ...remote().item_data.variations[0]?.item_variation_data,
        pricing_type: 'VARIABLE_PRICING',
      },
    },
  ])('does not confirm an invalid variation: %j', async change => {
    rows.set(squareCatalogOperations, pending);
    const result = remote();
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'POST')
        return Response.json({
          catalog_object: {
            ...result,
            item_data: {
              ...result.item_data,
              variations: [{ ...result.item_data.variations[0], ...change }],
            },
          },
        });
      if (!defaultFetch) throw new Error('Expected mocked fetch');
      return defaultFetch(input, init);
    });
    expect((await request('publish')).status).toBe(502);
    expect(storage.set).not.toHaveBeenCalledWith(squareCatalogOperations, {
      state: 'succeeded',
      error: null,
    });
  });
  test.each([
    0,
    -1,
    1.001,
    1.0000000000000002,
    100000000,
    '12.34',
  ])('rejects invalid price %s through HTTP', async inPersonPrice => {
    const response = await app.request(
      '/update-product',
      {
        method: 'PUT',
        headers: { Cookie: 'session=test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...item, image: '', inPersonPrice }),
      },
      bindings,
    );
    expect(response.status).toBe(400);
    expect(storage.set).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  test('money conversion keeps cents exact and strips internal revision', () => {
    expect(priceToCents(0.29)).toBe(29);
    expect(
      productPrices({ price: 19.95, inPersonPrice: 29, squareRevision: 3 }),
    ).toEqual({ price: 19.95, inPersonPrice: 0.29 });
  });
  describe.each([
    '/add-product',
    '/v2/add-product',
    '/update-product',
  ])('%s requires both prices', path => {
    test.each([
      ['price', undefined],
      ['price', null],
      ['inPersonPrice', undefined],
      ['inPersonPrice', null],
    ])('rejects %s = %s before saving or external requests', async (field, value) => {
      const response = await app.request(
        path,
        {
          method: path === '/update-product' ? 'PUT' : 'POST',
          headers: {
            Cookie: 'session=test',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...item,
            stl: 'file-123',
            publicFileServiceId: 'file-123',
            image: '',
            inPersonPrice: 12.34,
            [String(field)]: value,
          }),
        },
        bindings,
      );
      expect(response.status).toBe(400);
      expect(storage.insert).not.toHaveBeenCalled();
      expect(storage.set).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  });
  test('saving both prices stores In-Person Price as cents without publishing', async () => {
    const response = await app.request(
      '/update-product',
      {
        method: 'PUT',
        headers: { Cookie: 'session=test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...item, image: '', inPersonPrice: 0.29 }),
      },
      bindings,
    );
    expect(response.status).toBe(200);
    expect(storage.set).toHaveBeenCalledWith(
      productsTable,
      expect.objectContaining({ price: 19.95, inPersonPrice: 29 }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
