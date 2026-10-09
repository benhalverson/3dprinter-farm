import {
  Column,
  getTableColumns,
  is,
  Param,
  SQL,
  StringChunk,
} from 'drizzle-orm';
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
let rejectedWrites: { table: unknown; values: Record<string, unknown> }[];
let invocationDatabases: WorkerEnv['Variables']['db'][];
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
  // Each invocation receives a new app, Request and adapter over retained fixture records.
  boundary.db = mutationDatabase();
  invocationDatabases.push(boundary.db);
  const app = new Hono().route('/admin/product-drafts', router);
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
  rejectedWrites = [];
  invocationDatabases = [];
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
});

type Row = Record<string, unknown>;
type RowContext = Map<unknown, Row>;
type FixtureQuery = {
  from(table: unknown): FixtureQuery;
  where(condition: SQL): FixtureQuery;
  orderBy(): FixtureQuery;
  innerJoin(table: unknown, condition: SQL): FixtureQuery;
  getSQL(): SQL;
  fixtureRows(): RowContext[];
  projectRows(): Row[];
  select(source: FixtureQuery): FixtureQuery;
  get(): Promise<Row | undefined>;
  all(): Promise<Row[]>;
  returning(): Promise<Row[]>;
  then(
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ): Promise<unknown>;
  onConflictDoNothing(): FixtureQuery;
};
/** Bounded predicate model for this fixture only; unsupported expressions fail closed.
 * It evaluates Drizzle equality/IN/null/AND/EXISTS guards, not SQL or a database.
 */
function matches(condition: SQL | undefined, context: RowContext): boolean {
  if (!condition) return true;
  const chunks = condition.queryChunks;
  const text = chunks
    .filter(chunk => is(chunk, StringChunk))
    .map(chunk => chunk.value.join(''))
    .join('')
    .trim();
  const operands = chunks.filter(chunk => !is(chunk, StringChunk));
  const nested = operands.filter(chunk => is(chunk, SQL));
  if (text === '' || text === '()' || /^\(?(?:and\s*)+\)?$/.test(text))
    return (
      nested.length === operands.length &&
      nested.every(chunk => matches(chunk, context))
    );
  const value = (operand: unknown): unknown => {
    if (is(operand, Param)) return operand.value;
    if (is(operand, Column)) {
      const key = Object.entries(getTableColumns(operand.table)).find(
        ([, column]) => column === operand,
      )?.[0];
      if (!key) throw new Error('Unknown fixture column');
      return context.get(operand.table)?.[key];
    }
    if (
      typeof operand === 'string' ||
      typeof operand === 'number' ||
      operand === null
    )
      return operand;
    throw new Error('Unsupported fixture operand');
  };
  if (text === '=') {
    const left = value(operands[0]);
    const right = value(operands[1]);
    return left != null && right != null && left === right;
  }
  if (text === 'is null') return value(operands[0]) == null;
  if (text === 'in' && Array.isArray(operands[1])) {
    const left = value(operands[0]);
    return left != null && operands[1].some(item => value(item) === left);
  }
  if (text === 'exists' || text === 'not exists') {
    const subquery = operands[0] as { fixtureRows?: () => RowContext[] };
    if (!subquery.fixtureRows) throw new Error('Unsupported fixture subquery');
    const found = subquery.fixtureRows().length > 0;
    return text === 'exists' ? found : !found;
  }
  throw new Error(`Unsupported fixture predicate: ${text}`);
}
/** Rebuild a mocked Drizzle adapter; only the records above survive requests. */
function mutationDatabase(): WorkerEnv['Variables']['db'] {
  const rows = (table: unknown): Row[] => {
    if (table === organizationTable) return [{ id: 'org_shared_catalog' }];
    if (table === memberTable)
      return [
        {
          id: 'member',
          role: memberRole,
          userId: 'user_123',
          organizationId: 'org_shared_catalog',
        },
      ];
    if (table === productDrafts)
      return [{ id, ownerId: 'user_123', revision: 4, status: 'active' }];
    if (table === productMutationOperations)
      return operation ? [operation] : [];
    if (table === productsTable) return product ? [product] : [];
    if (table === squareCatalogMappings) return mapping ? [mapping] : [];
    return [];
  };
  const query = (
    table?: unknown,
    values?: Row,
    kind: 'select' | 'update' | 'insert' | 'delete' = 'select',
    selection?: Row,
  ): FixtureQuery => {
    let condition: SQL | undefined;
    let source: FixtureQuery | undefined;
    const joins: { table: unknown; condition: SQL }[] = [];
    const contexts = (): RowContext[] => {
      let contexts = rows(table).map(row => new Map([[table, row]]));
      for (const join of joins)
        contexts = contexts.flatMap(context =>
          rows(join.table)
            .map(
              row =>
                new Map([...context, [join.table, row]] as [unknown, Row][]),
            )
            .filter(candidate => matches(join.condition, candidate)),
        );
      return contexts.filter(context => matches(condition, context));
    };
    const project = (context: RowContext): Row =>
      selection
        ? Object.fromEntries(
            Object.entries(selection).map(([key, value]) => {
              if (!is(value, Column))
                throw new Error('Unsupported fixture projection');
              const sourceKey = Object.entries(
                getTableColumns(value.table),
              ).find(([, column]) => column === value)?.[0];
              return [
                key,
                sourceKey ? context.get(value.table)?.[sourceKey] : undefined,
              ];
            }),
          )
        : context.get(table)!;
    const execute = (): Row[] => {
      if (kind === 'select') return contexts().map(project);
      if (kind !== 'insert' && !contexts().length) {
        rejectedWrites.push({ table, values: values ?? {} });
        return [];
      }
      if (source && !source.fixtureRows().length) return [];
      const next = source ? source.projectRows()[0] : (values ?? {});
      writes.push({ table, values: next });
      if (table === productMutationOperations)
        operation = {
          ...(operation ?? savedOperation('prepared')),
          ...next,
        } as Operation;
      if (table === productsTable) {
        if (kind === 'delete') product = undefined;
        else if (kind === 'insert') product = { ...next, id: next.id ?? 7 };
        else product = { ...product, ...next };
      }
      if (table === squareCatalogMappings) mapping = { ...mapping, ...next };
      return rows(table);
    };
    const result: FixtureQuery = {
      from(next: unknown) {
        table = next;
        return result;
      },
      where(next: SQL) {
        condition = next;
        if (table === productMutationOperations) reads.push(next);
        return result;
      },
      orderBy() {
        return result;
      },
      innerJoin(table: unknown, condition: SQL) {
        joins.push({ table, condition });
        return result;
      },
      // Only required as a SQLWrapper marker; predicates use fixtureRows above.
      getSQL: (): SQL => {
        throw new Error('Unexpected compilation of fixture subquery');
      },
      fixtureRows: contexts,
      projectRows: () => contexts().map(project),
      select(next: FixtureQuery) {
        source = next;
        return result;
      },
      get: async () => structuredClone(execute()[0]),
      all: async () => structuredClone(execute()),
      returning: async () => structuredClone(execute()),
      // biome-ignore lint/suspicious/noThenProperty: Drizzle queries are awaitable at this mocked boundary.
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) =>
        Promise.resolve()
          .then(() => structuredClone(execute()))
          .then(resolve, reject),
      onConflictDoNothing() {
        return result;
      },
    };
    return result;
  };
  return {
    select: (selection?: Row) =>
      query(undefined, undefined, 'select', selection),
    insert: (table: unknown) => ({
      values: (values: Row) => query(table, values, 'insert'),
      select: (source: FixtureQuery) =>
        query(table, {}, 'insert').select(source),
    }),
    delete: (table: unknown) => query(table, {}, 'delete'),
    batch: async (queries: PromiseLike<unknown>[]) => {
      // Inject an unavailable boundary before any batch statement; this does not simulate rollback.
      if (failBatch) throw new Error('simulated database unavailable');
      for (const statement of queries) await statement;
      return [];
    },
    update: (table: unknown) => ({
      set: (values: Row) => query(table, values, 'update'),
    }),
  } as unknown as WorkerEnv['Variables']['db'];
}

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

type MutationAction = Operation['action'];
/** Prepare a current card while retaining a distinct catalog/mapping for existing items. */
function beginAction(action: MutationAction) {
  operation = undefined;
  product =
    action === 'create'
      ? undefined
      : {
          id: 7,
          squareRevision: 3,
          name: 'Previous catalog name',
          description: 'Previous copy',
          price: 2,
          inPersonPrice: 350,
          skuNumber: 'existing-sku',
          image: 'old-photo',
          stl: 'old-file',
          publicFileServiceId: 'old-slant-file',
        };
  mapping =
    action === 'create'
      ? undefined
      : {
          id: 'mapping',
          productId: 7,
          catalogId: 7,
          itemId: 'square-item',
          variationId: 'square-variation',
          generation: 3,
          published: 1,
          publishedSnapshot: 'previous-publication',
          environment: 'sandbox',
          merchantId: 'merchant',
          locationId: 'location',
        };
  vi.mocked(readCurrentPreparation).mockResolvedValue({
    ...preparation,
    snapshot: {
      ...preparation.snapshot,
      action,
      target:
        action === 'create'
          ? { kind: 'new' }
          : { kind: 'existing', productId: 7 },
      productRevision: action === 'create' ? null : 3,
    },
  });
  return structuredClone({ product, mapping });
}
/** Model Square's read and write HTTP contracts; all responses are synthetic. */
function squareResponses(
  write: (payload: string) => Promise<Response> | Response,
) {
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
      return confirmedSquareResponse(savedOperation().payload);
    expect(String(url)).toContain('/catalog/object');
    expect(init?.method).toBe('POST');
    return write(String(init?.body));
  });
}
function confirmedSquareResponse(payload: string) {
  const sent = JSON.parse(payload).object;
  return Response.json({
    catalog_object: {
      ...sent,
      id: 'square-item',
      version: 4,
      item_data: {
        ...sent.item_data,
        variations: sent.item_data.variations.map(
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
    },
  });
}
function definitiveRejection() {
  return Response.json(
    {
      errors: [
        {
          detail: 'private seller data secret-provider-token',
          code: 'INVALID_VALUE',
        },
      ],
    },
    { status: 400 },
  );
}
/** Discard object identities as if only serialized fixture records remain for the next invocation. */
function retainRecordsOnly() {
  operation = structuredClone(operation);
  product = structuredClone(product);
  mapping = structuredClone(mapping);
  boundary.db = undefined as unknown as WorkerEnv['Variables']['db'];
}
function retainedOperation() {
  if (!operation) throw new Error('Expected saved operation');
  return operation;
}
function localWrites() {
  return writes.filter(
    write =>
      write.table === productsTable || write.table === squareCatalogMappings,
  );
}
function assertFreshInvocations() {
  expect(invocationDatabases.length).toBeGreaterThan(1);
  expect(new Set(invocationDatabases).size).toBe(invocationDatabases.length);
}
function assertCompleted(action: MutationAction) {
  expect(retainedOperation().state).toBe('succeeded');
  if (action === 'delete') {
    expect(product).toBeUndefined();
    expect(mapping).toMatchObject({ published: 0, generation: 4 });
  } else {
    expect(product).toMatchObject({
      id: 7,
      name: 'Bracket',
      description: 'A bracket',
      price: 5,
      inPersonPrice: 725,
    });
    expect(mapping).toMatchObject({
      productId: 7,
      published: 1,
      generation: action === 'create' ? 0 : 4,
    });
  }
}

// Companion evidence for luluspeedworks#33 / luluspeedworks#70. These are mocked
// invocation boundaries, not a claim of actual Worker restarts or database atomicity.
describe.each([
  'create',
  'update',
  'delete',
] as const)('%s recovery across fresh mocked app invocations', action => {
  test('first definitive Square rejection is terminal, sanitized and unchanged on read/reconcile', async () => {
    const before = beginAction(action);
    squareResponses(() => definitiveRejection());
    const submitted = await request('submit', { ...input, action });
    expect(submitted.status).toBe(200);
    const response = await submitted.json();
    expect(response).toMatchObject({
      operation: {
        action,
        state: 'failed',
        retryable: false,
        error: 'square_request_rejected',
      },
    });
    expect(JSON.stringify(response)).not.toMatch(
      /private seller|secret-provider-token|INVALID_VALUE/,
    );
    const saved = structuredClone(retainedOperation());
    expect(saved).toMatchObject({
      state: 'failed',
      replayed: 0,
      error: 'square_request_rejected',
    });
    expect({ product, mapping }).toEqual(before);
    expect(localWrites()).toEqual([]);
    // The error-only write for pending/item_confirmed must not match a failed row.
    expect(rejectedWrites).toContainEqual(
      expect.objectContaining({
        table: productMutationOperations,
        values: expect.objectContaining({ error: 'square_request_rejected' }),
      }),
    );
    vi.mocked(fetch).mockClear();
    for (const endpoint of ['operation', 'reconcile']) {
      retainRecordsOnly();
      const recovered = await request(endpoint, { operationId: saved.id });
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        operation: {
          id: saved.id,
          state: 'failed',
          retryable: false,
          error: 'square_request_rejected',
        },
      });
    }
    expect(retainedOperation().payload).toBe(saved.payload);
    expect({ product, mapping }).toEqual(before);
    expect(localWrites()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    assertFreshInvocations();
  });

  test('rejection after an unknown outcome remains pending with the exact immutable replay payload', async () => {
    const before = beginAction(action);
    const payloads: string[] = [];
    squareResponses(payload => {
      payloads.push(payload);
      throw new Error('lost provider response secret-provider-token');
    });
    const first = await request('submit', { ...input, action });
    expect(await first.json()).toMatchObject({
      operation: {
        action,
        state: 'pending',
        retryable: true,
        error: 'square_outcome_unknown',
      },
    });
    const saved = structuredClone(retainedOperation());
    expect({ product, mapping }).toEqual(before);
    for (let retry = 0; retry < 2; retry++) {
      retainRecordsOnly();
      squareResponses(payload => {
        payloads.push(payload);
        return definitiveRejection();
      });
      const response = await request('reconcile', { operationId: saved.id });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        operation: {
          id: saved.id,
          state: 'pending',
          retryable: true,
          error: 'square_request_rejected',
        },
      });
      expect(JSON.stringify(body)).not.toContain('secret-provider-token');
      expect({ product, mapping }).toEqual(before);
    }
    expect(retainedOperation()).toMatchObject({
      id: saved.id,
      replayed: 1,
      payload: saved.payload,
    });
    expect(payloads).toEqual([saved.payload, saved.payload, saved.payload]);
    expect(localWrites()).toEqual([]);
    assertFreshInvocations();
  });

  test('an overlapping replay prevents the original late rejection from retiring the operation', async () => {
    const before = beginAction(action);
    let rejectFirst!: (response: Response) => void;
    let rejectReplay!: (response: Response) => void;
    let firstDispatched!: () => void;
    let replayDispatched!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      firstDispatched = resolve;
    });
    const replayStarted = new Promise<void>(resolve => {
      replayDispatched = resolve;
    });
    const payloads: string[] = [];
    squareResponses(payload => {
      payloads.push(payload);
      if (payloads.length === 1)
        return new Promise<Response>(resolve => {
          rejectFirst = resolve;
          firstDispatched();
        });
      return new Promise<Response>(resolve => {
        rejectReplay = resolve;
        replayDispatched();
      });
    });
    const original = request('submit', { ...input, action });
    await firstStarted;
    const saved = structuredClone(retainedOperation());
    const replay = request('reconcile', { operationId: saved.id });
    await replayStarted;
    expect(retainedOperation().replayed).toBe(1);
    rejectFirst(definitiveRejection());
    expect(await (await original).json()).toMatchObject({
      operation: { id: saved.id, state: 'pending', retryable: true },
    });
    expect(rejectedWrites).toContainEqual(
      expect.objectContaining({
        table: productMutationOperations,
        values: expect.objectContaining({ state: 'failed' }),
      }),
    );
    rejectReplay(definitiveRejection());
    expect(await (await replay).json()).toMatchObject({
      operation: { id: saved.id, state: 'pending', retryable: true },
    });
    expect(payloads).toEqual([saved.payload, saved.payload]);
    expect({ product, mapping }).toEqual(before);
    expect(localWrites()).toEqual([]);
    assertFreshInvocations();
  });

  test('unknown provider outcome recovers once, with later terminal reads/replays requiring no provider or catalog mutation', async () => {
    const before = beginAction(action);
    squareResponses(() => {
      throw new Error('response lost');
    });
    await request('submit', { ...input, action });
    const saved = structuredClone(retainedOperation());
    expect({ product, mapping }).toEqual(before);
    expect(localWrites()).toEqual([]);
    retainRecordsOnly();
    squareResponses(payload => {
      expect(payload).toBe(saved.payload);
      expect({ product, mapping }).toEqual(before);
      return confirmedSquareResponse(payload);
    });
    const recovered = await request('reconcile', { operationId: saved.id });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      operation: { id: saved.id, state: 'succeeded', retryable: false },
    });
    assertCompleted(action);
    const completed = structuredClone({ product, mapping });
    const productWriteCount = writes.filter(
      write => write.table === productsTable,
    ).length;
    expect(productWriteCount).toBe(1);
    const catalogWrites = localWrites().length;
    vi.mocked(fetch).mockClear();
    for (const endpoint of ['operation', 'reconcile', 'reconcile']) {
      retainRecordsOnly();
      expect(
        await (await request(endpoint, { operationId: saved.id })).json(),
      ).toMatchObject({
        operation: { id: saved.id, state: 'succeeded', retryable: false },
        storefrontVisible: action !== 'delete',
      });
    }
    expect({ product, mapping }).toEqual(completed);
    expect(localWrites()).toHaveLength(catalogWrites);
    expect(fetch).not.toHaveBeenCalled();
    assertFreshInvocations();
  });

  test('confirmed Square success survives repeated local completion failures and resumes only the retained local work', async () => {
    const before = beginAction(action);
    failBatch = true;
    squareResponses(payload => confirmedSquareResponse(payload));
    const first = await request('submit', { ...input, action });
    expect(await first.json()).toMatchObject({
      operation: {
        state: 'repair_required',
        retryable: true,
        error: 'local_completion_failed',
      },
    });
    const saved = structuredClone(retainedOperation());
    expect(saved.squareResult).not.toBeNull();
    expect({ product, mapping }).toEqual(before);
    expect(localWrites()).toEqual([]);
    vi.mocked(fetch).mockClear();
    for (let retry = 0; retry < 2; retry++) {
      retainRecordsOnly();
      expect(
        await (await request('reconcile', { operationId: saved.id })).json(),
      ).toMatchObject({
        operation: {
          id: saved.id,
          state: 'repair_required',
          retryable: true,
          error: 'local_completion_failed',
        },
      });
      expect({ product, mapping }).toEqual(before);
      expect(localWrites()).toEqual([]);
      expect(retainedOperation().payload).toBe(saved.payload);
    }
    failBatch = false;
    retainRecordsOnly();
    expect(
      await (await request('reconcile', { operationId: saved.id })).json(),
    ).toMatchObject({
      operation: { id: saved.id, state: 'succeeded', retryable: false },
      storefrontVisible: action !== 'delete',
    });
    assertCompleted(action);
    expect(writes.filter(write => write.table === productsTable)).toHaveLength(
      1,
    );
    expect(fetch).not.toHaveBeenCalled();
    assertFreshInvocations();
  });
});

describe.each([
  'update',
  'delete',
] as const)('%s guarded local recovery', action => {
  test.each([
    'product',
    'mapping',
  ] as const)('keeps newer %s state intact through repeated repair attempts', async changed => {
    beginAction(action);
    failBatch = true;
    squareResponses(payload => confirmedSquareResponse(payload));
    await request('submit', { ...input, action });
    const saved = structuredClone(retainedOperation());
    expect(saved.state).toBe('repair_required');
    failBatch = false;
    if (changed === 'product')
      product = { ...product, squareRevision: 4, name: 'Newer editor value' };
    else
      mapping = {
        ...mapping,
        generation: 4,
        publishedSnapshot: 'newer-publication',
      };
    const newer = structuredClone({ product, mapping });
    vi.mocked(fetch).mockClear();
    for (let retry = 0; retry < 2; retry++) {
      retainRecordsOnly();
      expect(
        await (await request('reconcile', { operationId: saved.id })).json(),
      ).toMatchObject({
        operation: {
          id: saved.id,
          state: 'repair_required',
          retryable: true,
          error: 'local_completion_conflict',
        },
      });
      expect({ product, mapping }).toEqual(newer);
      expect(retainedOperation().payload).toBe(saved.payload);
      expect(localWrites()).toEqual([]);
    }
    expect(rejectedWrites).toContainEqual(
      expect.objectContaining({
        table: productMutationOperations,
        values: expect.objectContaining({
          completionToken: expect.any(String),
        }),
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    assertFreshInvocations();
  });
});
