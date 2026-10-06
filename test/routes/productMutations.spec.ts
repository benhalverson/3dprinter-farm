import { eq, type SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  memberTable,
  organizationTable,
  productDrafts,
  productMutationOperations,
  productsTable,
  squareCatalogMappings,
} from '../../src/db/schema';
import type { WorkerEnv } from '../../src/factory';
import { readCurrentPreparation } from '../../src/modules/productPreparation';
import type { ProductPreparation } from '../../src/modules/productPreparationContracts';
import router from '../../src/routes/productDrafts';
import { mockBetterAuth } from '../mocks/auth';
import { mockEnv } from '../mocks/env';

const boundary = vi.hoisted(() => ({ db: {} as WorkerEnv['Variables']['db'] }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => boundary.db }));
vi.mock('../../src/modules/productPreparation', async original => ({
  ...(await original<typeof import('../../src/modules/productPreparation')>()),
  readCurrentPreparation: vi.fn(),
}));

vi.mock('../../src/modules/catalogReadiness', () => ({
  evaluateCatalogReadiness: vi.fn(async () => ({
    products: [{ ready: true }],
  })),
}));

type Operation = typeof productMutationOperations.$inferSelect;
const id = '11111111-1111-4111-8111-111111111111';
const preparationId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const app = new Hono().route('/admin/product-drafts', router);
const bindings = {
  ...mockEnv(),
  SQUARE_ENVIRONMENT: 'sandbox' as const,
  SQUARE_ACCESS_TOKEN: 'secret-provider-token',
  SQUARE_MERCHANT_ID: 'merchant',
  SQUARE_LOCATION_ID: 'location',
};
const input = { expectedRevision: 4, preparationId, action: 'create' };
let operation: Operation | undefined;
let memberRole: string;
let failBatch: boolean;
let product: Record<string, unknown> | undefined;
let mapping: Record<string, unknown> | undefined;
let reads: SQL[];
let writes: { table: unknown; values: Record<string, unknown> }[];
const dialect = new SQLiteSyncDialect();
const preparation = {
  id: preparationId,
  draftRevision: 4,
  preparedAt: 1,
  status: 'ready',
  readiness: { ready: true, submissionAuthorized: false },
  validation: [],
  pricing: {
    currency: 'USD',
    productionCost: 3,
    markupPercentage: null,
    onlinePrice: 5,
    inPersonPrice: 7.25,
    basis: null,
  },
  snapshot: {
    target: { kind: 'new' },
    action: 'create',
    cleanupAssetIds: [],
    productRevision: null,
    name: 'Bracket',
    description: 'A bracket',
    categoryIds: [],
    filamentType: 'PLA',
    color: 'Blue',
    publicFileServiceId: 'file',
    stl: 'https://files.example/bracket.stl',
    image: '',
    imageGallery: [],
    primaryPhotoAssetId: null,
    assetIds: [],
    assetRevisions: [],
    categoryBindings: [],
    sourceBinding: 'retained-file',
  },
} satisfies ProductPreparation;
function savedOperation(state: Operation['state'] = 'pending'): Operation {
  return {
    id: operationId,
    draftId: id,
    ownerId: 'user_123',
    preparationId,
    draftRevision: 4,
    action: 'create',
    state,
    preparation,
    productId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    environment: 'sandbox',
    merchantId: 'merchant',
    locationId: 'location',
    payload: JSON.stringify({
      idempotency_key: operationId,
      object: {
        id: '#item',
        type: 'ITEM',
        item_data: {
          name: 'Bracket',
          description: 'A bracket',
          is_archived: false,
          variations: [
            {
              id: '#in-person',
              type: 'ITEM_VARIATION',
              item_variation_data: {
                item_id: '#item',
                name: 'In-Person · PLA · Blue',
                sku: operationId,
                price_money: { amount: 725, currency: 'USD' },
                pricing_type: 'FIXED_PRICING',
                track_inventory: false,
              },
            },
          ],
        },
      },
    }),
    localInPersonPrice: 725,
    replayed: 0,
    squareResult: null,
    mappingId: operationId,
    mappingGeneration: 0,
    completionToken: null,
    imagePayload: null,
    resultImageId: null,
    cleanup: [],
    localError: null,
    resultItemId: null,
    resultVariationId: null,
    localId: null,
    localName: 'Bracket',
    localDescription: 'A bracket',
    localImage: '',
    localImageGallery: '[]',
    localStl: preparation.snapshot.stl,
    localPrice: 5,
    localMarkupPercentage: null,
    localFilamentType: 'PLA',
    localSkuNumber: operationId,
    localColor: 'Blue',
    localPublicFileServiceId: 'file',
    localCategoryId: null,
    localSquareRevision: 0,
    localPublished: 1,
    localPublishedSnapshot: '{}',
    localCreatedAt: '2026-10-06',
    localNull: null,
  };
}
function request(
  action = 'submit',
  body: unknown = input,
  authenticated = true,
  draftId = id,
) {
  return app.request(
    `/admin/product-drafts/${draftId}/${action}`,
    {
      method: action === 'operation' ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { Cookie: 'session=test' } : {}),
      },
      ...(action === 'operation'
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    },
    bindings,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  operation = savedOperation();
  product = undefined;
  mapping = undefined;
  failBatch = false;
  memberRole = 'admin';
  reads = [];
  writes = [];
  mockBetterAuth.getSession
    .mockReset()
    .mockImplementation(async ({ headers } = {}) =>
      headers?.get('Cookie')
        ? {
            session: { id: 'session', expiresAt: new Date(Date.now() + 10000) },
            user: {
              id: 'user_123',
              role: 'admin',
              name: 'Admin',
              email: 'admin@example.com',
            },
          }
        : null,
    );
  vi.mocked(readCurrentPreparation).mockReset().mockResolvedValue(preparation);
  vi.mocked(fetch)
    .mockReset()
    .mockRejectedValue(new Error('secret-provider-token: request failed'));
  const query = (
    table?: unknown,
    values?: Record<string, unknown>,
    kind: 'update' | 'insert' | 'delete' = 'update',
  ) => {
    const execute = () => {
      if (values) {
        writes.push({ table, values });
        if (table === productMutationOperations)
          operation = {
            ...(operation ?? savedOperation('prepared')),
            ...values,
          } as Operation;
        if (table === productsTable) {
          if (kind === 'delete') product = undefined;
          else if (kind === 'insert' && operation)
            product = {
              id: 7,
              name: operation.localName,
              description: operation.localDescription,
              price: operation.localPrice,
              inPersonPrice: operation.localInPersonPrice,
              squareRevision: operation.localSquareRevision,
              skuNumber: operation.localSkuNumber,
              catalogMutationId: operation.id,
            };
          else product = { ...product, ...values };
        }
        if (table === squareCatalogMappings)
          mapping = { ...mapping, ...values };
      }
    };
    const result = {
      from(next: unknown) {
        return query(next, values, kind);
      },
      where(condition: SQL) {
        if (table === productMutationOperations) reads.push(condition);
        return result;
      },
      orderBy() {
        return result;
      },
      innerJoin() {
        return result;
      },
      getSQL: () => eq(productsTable.id, 1),
      get: async () => {
        if (table === organizationTable) return { id: 'org_shared_catalog' };
        if (table === memberTable) return { id: 'member', role: memberRole };
        if (table === productMutationOperations) return operation;
        if (table === productDrafts)
          return { id, ownerId: 'user_123', revision: 4, status: 'active' };
        if (table === productsTable) return product;
        if (table === squareCatalogMappings) return mapping;
        return undefined;
      },
      returning: async () => {
        execute();
        return operation ? [operation] : [];
      },
      // biome-ignore lint/suspicious/noThenProperty: Drizzle queries are awaitable at this scripted boundary.
      then: (resolve: (value: unknown) => unknown) => {
        execute();
        return Promise.resolve(resolve(undefined));
      },
      onConflictDoNothing() {
        return result;
      },
    };
    return result;
  };
  boundary.db = {
    select: () => query(),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) =>
        query(table, values, 'insert'),
      select: () => query(table, {}, 'insert'),
    }),
    delete: (table: unknown) => query(table, {}, 'delete'),
    batch: async (queries: PromiseLike<unknown>[]) => {
      if (failBatch) throw new Error('simulated database unavailable');
      for (const statement of queries) await statement;
      return [];
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => query(table, values),
    }),
  } as unknown as WorkerEnv['Variables']['db'];
});

describe('Product mutation HTTP with scripted Drizzle and mocked Square', () => {
  test('requires an authenticated catalog administrator for every operation route', async () => {
    for (const action of ['submit', 'operation', 'reconcile']) {
      const body = action === 'reconcile' ? { operationId } : input;
      expect((await request(action, body, false)).status).toBe(401);
      memberRole = 'member';
      expect((await request(action, body)).status).toBe(403);
      memberRole = 'admin';
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  test.each([
    {},
    { ...input, expectedRevision: 0 },
    { ...input, preparationId: 'bad' },
    { ...input, action: 'publish' },
    { ...input, confirm: true },
    '{invalid',
  ])('rejects malformed submission before touching durable state: %j', async body => {
    expect((await request('submit', body)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  test.each([
    {},
    { operationId: 'bad' },
    { operationId, force: true },
  ])('rejects malformed reconciliation: %j', async body => {
    const response = await request('reconcile', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid input' });
    expect(fetch).not.toHaveBeenCalled();
  });
  test('validates UUID path identifiers before reading recovery state', async () => {
    expect(
      (await request('operation', undefined, true, 'not-a-draft')).status,
    ).toBe(400);
    expect(reads).toEqual([]);
  });
  test('duplicate submit returns the saved operation without republishing', async () => {
    for (let count = 0; count < 2; count++) {
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        operation: { id: operationId, state: 'pending', retryable: true },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(readCurrentPreparation).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  test('requires reconciliation when a different preparation is submitted over an unresolved operation', async () => {
    const response = await request('submit', { ...input, expectedRevision: 5 });
    expect(response.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  test('rejects stale preparation before provider dispatch', async () => {
    operation = undefined;
    vi.mocked(readCurrentPreparation).mockResolvedValue({
      ...preparation,
      status: 'stale',
    });
    expect((await request()).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  test('operation read exposes recovery evidence without persisted provider payload or credentials', async () => {
    const response = await request('operation');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      product: null,
      readiness: null,
      storefrontVisible: false,
      operation: {
        id: operationId,
        draftId: id,
        preparationId,
        action: 'create',
        state: 'pending',
        productId: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
        retryable: true,
        cleanup: [],
      },
    });
    const conditions = reads.map(condition => dialect.sqlToQuery(condition));
    expect(
      conditions.some(
        condition =>
          condition.params.includes('user_123') &&
          condition.params.includes(id),
      ),
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('missing operation read returns null and reconciliation returns not found', async () => {
    operation = undefined;
    expect(await (await request('operation')).json()).toMatchObject({
      operation: null,
    });
    expect((await request('reconcile', { operationId })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('uncertain provider response retains pending state, exact saved payload, and local catalog', async () => {
    const payload = operation?.payload;
    const response = await request('reconcile', { operationId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operation: {
        state: 'pending',
        error: 'square_outcome_unknown',
        retryable: true,
        cleanup: [],
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(payload);
    expect(operation?.payload).toBe(payload);
    expect(
      writes.every(write => write.table === productMutationOperations),
    ).toBe(true);
  });
  test('mismatched provider confirmation remains pending without catalog writes', async () => {
    const saved = operation;
    if (!saved) throw new Error('Expected saved operation');
    const expected = JSON.parse(saved.payload).object;
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        catalog_object: {
          ...expected,
          id: 'square-item',
          version: 2,
          present_at_all_locations: false,
          present_at_location_ids: ['location'],
          item_data: {
            ...expected.item_data,
            name: 'Wrong product',
            variations: [
              {
                ...expected.item_data.variations[0],
                id: 'square-variation',
                version: 2,
                present_at_all_locations: false,
                present_at_location_ids: ['location'],
                item_variation_data: {
                  ...expected.item_data.variations[0].item_variation_data,
                  item_id: 'square-item',
                },
              },
            ],
          },
        },
      }),
    );
    const response = await request('reconcile', { operationId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operation: {
        state: 'pending',
        error: 'square_publication_response_mismatch',
      },
    });
    expect(
      writes.every(write => write.table === productMutationOperations),
    ).toBe(true);
  });
  test.each([
    'square_confirmed',
    'repair_required',
  ] as const)('confirmed %s recovery retries local work without provider dispatch', async state => {
    operation = {
      ...savedOperation(state),
      preparation: {
        ...preparation,
        snapshot: {
          ...preparation.snapshot,
          categoryBindings: [{ categoryId: 9, categoryName: 'Mounts' }],
        },
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request('reconcile', { operationId });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        operation: {
          state: 'repair_required',
          error: 'completion_binding_changed',
          retryable: true,
        },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(
      writes.every(write => write.table === productMutationOperations),
    ).toBe(true);
  });
  test.each([
    'create',
    'update',
    'delete',
  ] as const)('fresh %s confirms Square before coherent local completion', async action => {
    operation = undefined;
    const current =
      action === 'create'
        ? preparation
        : {
            ...preparation,
            snapshot: {
              ...preparation.snapshot,
              action,
              target: { kind: 'existing' as const, productId: 7 },
              productRevision: 3,
            },
          };
    vi.mocked(readCurrentPreparation).mockResolvedValue(current);
    if (action !== 'create') {
      product = {
        id: 7,
        squareRevision: 3,
        name: 'Old name',
        price: 1,
        inPersonPrice: 100,
        skuNumber: 'retained-sku',
      };
      mapping = {
        id: 'mapping',
        productId: 7,
        itemId: 'square-item',
        variationId: 'square-variation',
        generation: 3,
        environment: 'sandbox',
        merchantId: 'merchant',
        locationId: 'location',
      };
    }
    const remote = () => {
      const source = JSON.parse(savedOperation().payload).object;
      return {
        ...source,
        id: 'square-item',
        version: 3,
        item_data: {
          ...source.item_data,
          variations: [
            {
              ...source.item_data.variations[0],
              id: 'square-variation',
              version: 3,
              item_variation_data: {
                ...source.item_data.variations[0].item_variation_data,
                item_id: 'square-item',
              },
            },
          ],
        },
      };
    };
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/locations/location'))
        return Response.json({
          location: {
            id: 'location',
            merchant_id: 'merchant',
            currency: 'USD',
            status: 'ACTIVE',
          },
        });
      if (init?.method === 'GET')
        return Response.json({ catalog_object: remote() });
      // Provider dispatch must precede the first local product/mapping mutation.
      expect(
        writes.some(
          write =>
            write.table === productsTable ||
            write.table === squareCatalogMappings,
        ),
      ).toBe(false);
      const sent = JSON.parse(String(init?.body));
      expect(sent.idempotency_key).toBe(operation?.id);
      expect(sent.object.item_data.is_archived).toBe(action === 'delete');
      const confirmed = {
        ...sent.object,
        id: 'square-item',
        version: 4,
        item_data: {
          ...sent.object.item_data,
          variations: sent.object.item_data.variations.map(
            (variation: Record<string, unknown>) => ({
              ...variation,
              id: 'square-variation',
              version: 4,
              item_variation_data: {
                ...(variation.item_variation_data as Record<string, unknown>),
                item_id: 'square-item',
              },
            }),
          ),
        },
      };
      return Response.json({ catalog_object: confirmed });
    });
    const response = await request('submit', { ...input, action });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operation: { action, state: 'succeeded', retryable: false },
      storefrontVisible: action !== 'delete',
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
    expect((operation as Operation | undefined)?.state).toBe('succeeded');
    if (action === 'delete') {
      expect(product).toBeUndefined();
      expect(mapping?.published).toBe(0);
    } else {
      expect(product).toMatchObject({
        name: 'Bracket',
        price: 5,
        inPersonPrice: 725,
      });
    }
    const confirmedIndex = writes.findIndex(
      write =>
        write.table === productMutationOperations &&
        write.values.state === 'square_confirmed',
    );
    const localIndex = writes.findIndex(write => write.table === productsTable);
    expect(confirmedIndex).toBeGreaterThanOrEqual(0);
    expect(localIndex).toBeGreaterThan(confirmedIndex);
  });
  test('confirmed item with unavailable primary image stays recoverable and leaves local catalog untouched', async () => {
    operation = {
      ...savedOperation(),
      preparation: {
        ...preparation,
        snapshot: {
          ...preparation.snapshot,
          primaryPhotoAssetId: 'missing-photo',
        },
      },
    };
    const expected = JSON.parse(operation.payload).object;
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        catalog_object: {
          ...expected,
          id: 'square-item',
          version: 2,
          present_at_all_locations: false,
          present_at_location_ids: ['location'],
          item_data: {
            ...expected.item_data,
            variations: [
              {
                ...expected.item_data.variations[0],
                id: 'square-variation',
                version: 2,
                present_at_all_locations: false,
                present_at_location_ids: ['location'],
                item_variation_data: {
                  ...expected.item_data.variations[0].item_variation_data,
                  item_id: 'square-item',
                },
              },
            ],
          },
        },
      }),
    );
    const response = await request('reconcile', { operationId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operation: {
        state: 'item_confirmed',
        error: 'primary_photo_unavailable',
        retryable: true,
      },
    });
    expect(
      writes.every(write => write.table === productMutationOperations),
    ).toBe(true);
    expect(product).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test('database completion failure retries the immutable local snapshot without republishing', async () => {
    operation = savedOperation('square_confirmed');
    failBatch = true;
    const interrupted = await request('reconcile', { operationId });
    expect(await interrupted.json()).toMatchObject({
      operation: {
        state: 'repair_required',
        error: 'local_completion_failed',
        retryable: true,
      },
    });
    expect(product).toBeUndefined();
    failBatch = false;
    const recovered = await request('reconcile', { operationId });
    expect(await recovered.json()).toMatchObject({
      operation: { state: 'succeeded', productId: 7, retryable: false },
      product: { name: 'Bracket', price: 5, inPersonPrice: 7.25 },
    });
    expect(product).toMatchObject({ price: 5, inPersonPrice: 725 });
    expect(fetch).not.toHaveBeenCalled();
  });
  test('reconciliation retires an inert prepared operation without provider effects', async () => {
    operation = savedOperation('prepared');
    const response = await request('reconcile', { operationId });
    expect(await response.json()).toMatchObject({
      operation: {
        state: 'failed',
        error: 'inert_operation_retired_reprepare',
        retryable: false,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(writes.some(write => write.table === productsTable)).toBe(false);
  });
  test('successful edit permits a different current preparation to start another edit', async () => {
    operation = { ...savedOperation('succeeded'), action: 'update' };
    const nextId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(readCurrentPreparation).mockResolvedValue({
      ...preparation,
      id: nextId,
      snapshot: {
        ...preparation.snapshot,
        action: 'update',
        target: { kind: 'existing', productId: 7 },
        productRevision: 3,
      },
    });
    // Missing target proves this request passed old-operation duplicate detection
    // and reached authoritative current product validation, before provider writes.
    const response = await request('submit', {
      ...input,
      preparationId: nextId,
      action: 'update',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'catalog_changed_retry' });
    expect(readCurrentPreparation).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('a delete preparation cannot authorize an update submission', async () => {
    operation = undefined;
    vi.mocked(readCurrentPreparation).mockResolvedValue({
      ...preparation,
      snapshot: {
        ...preparation.snapshot,
        action: 'delete',
        target: { kind: 'existing', productId: 7 },
        productRevision: 3,
      },
    });
    const response = await request('submit', { ...input, action: 'update' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'prepared_action_mismatch',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  test('terminal operation reconciliation is idempotent and never sends another provider request', async () => {
    operation = savedOperation('succeeded');
    const response = await request('reconcile', { operationId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operation: { state: 'succeeded', retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(writes.some(write => write.table === productsTable)).toBe(false);
  });
});
