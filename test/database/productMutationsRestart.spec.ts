import * as schema from '../../src/db/schema';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import harness from './productMutationHarness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  productAssetReferenceAttempts,
  productAssets,
  productMutationOperations,
  productsTable,
  productsToCategories,
  squareCatalogMappings,
} from '../../src/db/schema';
import type { ProductPreparation } from '../../src/modules/productPreparationContracts';
import { createDisposableDatabase } from './disposableDatabase';

type Operation = typeof productMutationOperations.$inferSelect;
type Snapshot = {
  assets: (typeof productAssets.$inferSelect)[];
  attempts: (typeof productAssetReferenceAttempts.$inferSelect)[];
  products: (typeof productsTable.$inferSelect)[];
  mappings: (typeof squareCatalogMappings.$inferSelect)[];
  categories: (typeof productsToCategories.$inferSelect)[];
  operations: Operation[];
};
let root: string;
let fixture: Awaited<ReturnType<typeof createDisposableDatabase>>;
let sequence = 0;
beforeAll(async () => {
  fixture = await createDisposableDatabase();
  root = await mkdtemp(join(tmpdir(), 'product-mutations-restart-'));
});
afterAll(async () => {
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Frozen confirmed operations intentionally bypass all provider dispatch while exercising actual local recovery. */
function operation(
  action: 'create' | 'update' | 'delete',
  state: Operation['state'] = 'square_confirmed',
): typeof productMutationOperations.$inferInsert {
  const id = `operation-${++sequence}`;
  const preparation: ProductPreparation = {
    id: '11111111-1111-4111-8111-111111111111',
    draftRevision: 1,
    preparedAt: 1,
    status: 'ready',
    readiness: { ready: true, submissionAuthorized: false },
    validation: [],
    pricing: {
      currency: 'USD',
      productionCost: 2,
      markupPercentage: 50,
      onlinePrice: 3,
      inPersonPrice: 5,
      basis: null,
    },
    snapshot: {
      action,
      cleanupAssetIds: [],
      target:
        action === 'create'
          ? { kind: 'new' }
          : { kind: 'existing', productId: 1 },
      productRevision: action === 'create' ? null : 0,
      name: 'New bracket',
      description: 'Frozen description',
      categoryIds: [1],
      categoryBindings: [{ categoryId: 1, categoryName: 'Mounts' }],
      filamentType: 'PLA',
      color: 'Blue',
      publicFileServiceId: 'file',
      stl: 'file.stl',
      image: 'photo',
      imageGallery: ['photo'],
      primaryPhotoAssetId: null,
      assetIds: [],
      assetRevisions: [],
      sourceBinding: 'fixture',
    },
  };
  return {
    id,
    ownerId: 'owner',
    draftId: `draft-${id}`,
    preparationId: `prepared-${id}`,
    draftRevision: 1,
    action,
    state,
    preparation,
    payload: '{}',
    environment: 'sandbox',
    merchantId: 'merchant',
    locationId: 'location',
    productId: action === 'create' ? null : 1,
    mappingId: `mapping-${id}`,
    mappingGeneration: action === 'create' ? null : 0,
    resultItemId: 'square-item',
    resultVariationId: 'square-variation',
    localName: 'New bracket',
    localDescription: 'Frozen description',
    localImage: 'photo',
    localImageGallery: '["photo"]',
    localStl: 'file.stl',
    localPrice: 3,
    localMarkupPercentage: 50,
    localFilamentType: 'PLA',
    localSkuNumber: 'SKU',
    localColor: 'Blue',
    localInPersonPrice: 500,
    localPublicFileServiceId: 'file',
    localSquareRevision: 1,
    localPublishedSnapshot: '{}',
    localCreatedAt: '2026-10-06T00:00:00Z',
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Reopen the same local SQLite file; provider calls remain explicitly mocked. */
function runtime(storage: string) {
  mkdirSync(storage, { recursive: true });
  const client = createClient({ url: `file:${join(storage, 'data.sqlite')}` });
  const db = drizzle(client, { schema });
  const env = {
    db,
    SQUARE_ENVIRONMENT: 'sandbox',
    SQUARE_ACCESS_TOKEN: 'local-test-placeholder',
    SQUARE_MERCHANT_ID: 'merchant',
    SQUARE_LOCATION_ID: 'location',
  };
  return {
    db,
    async dispatchFetch(url: string, init: RequestInit) {
      return harness.fetch(new Request(url, init), env);
    },
    async dispose() {
      client.close();
    },
  };
}
async function call(
  worker: ReturnType<typeof runtime>,
  input: object,
): Promise<Snapshot> {
  const response = await worker.dispatchFetch('http://local.test', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<Snapshot>;
}
async function seeded(
  worker: ReturnType<typeof runtime>,
  mutation: typeof productMutationOperations.$inferInsert,
) {
  await migrate(worker.db, {
    migrationsFolder: join(fixture.root, 'generated'),
  });
  return call(worker, {
    command: 'seed',
    category: { categoryId: 1, categoryName: 'Mounts' },
    ...(mutation.action === 'create'
      ? {}
      : {
          product: {
            id: 1,
            name: 'Original',
            description: 'Original',
            stl: 'original.stl',
            squareRevision: 0,
          },
          mapping: {
            id: mutation.mappingId,
            productId: 1,
            catalogId: 1,
            environment: 'sandbox',
            merchantId: 'merchant',
            locationId: 'location',
            itemId: 'square-item',
            variationId: 'square-variation',
            published: 1,
            generation: 0,
          },
        }),
    operation: mutation,
  });
}

describe('durable product mutation completion on actual persisted D1', () => {
  it.each([
    'create',
    'update',
    'delete',
  ] as const)('atomically completes confirmed %s once across worker restart', async action => {
    const mutation = operation(action);
    const storage = join(root, mutation.id);
    let worker = runtime(storage);
    try {
      await seeded(worker, mutation);
      await worker.dispose();
      worker = runtime(storage);
      const completed = await call(worker, {
        command: 'reconcile',
        id: mutation.id,
      });
      expect(completed.operations[0]).toMatchObject({
        state: 'succeeded',
        error: null,
      });
      if (action === 'delete') {
        expect(completed.products).toEqual([]);
        expect(completed.mappings[0]).toMatchObject({
          published: 0,
          productId: null,
          generation: 1,
        });
      } else {
        expect(completed.products).toHaveLength(1);
        expect(completed.products[0]).toMatchObject({
          name: 'New bracket',
          price: 3,
          inPersonPrice: 500,
          markupPercentage: 50,
          squareRevision: 1,
          catalogMutationId: mutation.id,
        });
        expect(completed.categories).toHaveLength(1);
        expect(completed.mappings).toHaveLength(1);
        expect(completed.mappings[0]).toMatchObject({
          published: 1,
          generation: 1,
          itemId: 'square-item',
          variationId: 'square-variation',
        });
      }
      await worker.dispose();
      worker = runtime(storage);
      const replay = await call(worker, {
        command: 'reconcile',
        id: mutation.id,
      });
      expect(replay.products).toEqual(completed.products);
      expect(replay.mappings).toEqual(completed.mappings);
      expect(replay.categories).toEqual(completed.categories);
      expect(replay.operations[0].state).toBe('succeeded');
    } finally {
      await worker.dispose();
    }
  });
  it.each([
    'category',
    'product',
  ] as const)('leaves %s conflict as visible repair without partially applying the catalog snapshot', async conflict => {
    const mutation = operation('update');
    const worker = runtime(join(root, mutation.id));
    try {
      const before = await seeded(worker, mutation);
      await call(
        worker,
        conflict === 'category'
          ? { command: 'category', categoryName: 'Reassigned' }
          : { command: 'revision', revision: 2 },
      );
      const result = await call(worker, {
        command: 'reconcile',
        id: mutation.id,
      });
      expect(result.operations[0].state).toBe('repair_required');
      expect(result.products[0]).toMatchObject({
        name: 'Original',
        description: 'Original',
      });
      expect(result.mappings).toEqual(before.mappings);
      expect(result.categories).toEqual([]);
    } finally {
      await worker.dispose();
    }
  });
  it.each([
    'update',
    'delete',
  ] as const)('releases original asset and attempt holds after %s while retaining independent draft protection', async action => {
    const mutation = operation(action);
    const oldId = 'original-photo';
    const newId = 'replacement-photo';
    if (!mutation.preparation.snapshot)
      throw new Error('Missing fixture snapshot');
    mutation.preparation.snapshot.cleanupAssetIds = [oldId, newId];
    mutation.preparation.snapshot.assetIds = action === 'delete' ? [] : [newId];
    const worker = runtime(join(root, mutation.id));
    try {
      await seeded(worker, mutation);
      await call(worker, {
        command: 'seed',
        assets: [oldId, newId].map(id => ({
          id,
          ownerId: 'owner',
          draftId: 'retained-draft',
          kind: 'photo',
          objectKey: id,
          encryptionKey: 'unused-test-key',
          status: 'active',
          revision: 1,
          references: [
            `catalog-attempt:${mutation.id}`,
            'draft:retained',
            ...(id === oldId ? ['catalog:1'] : []),
          ],
        })),
        attempt: {
          id: `catalog-attempt:${mutation.id}`,
          assetIds: [oldId, newId],
          state: 'unresolved',
          createdAt: 1,
          updatedAt: 1,
        },
      });
      const result = await call(worker, {
        command: 'reconcile',
        id: mutation.id,
      });
      expect(result.operations[0].state).toBe('succeeded');
      expect(result.attempts[0].state).toBe('released');
      expect(
        result.assets.find(asset => asset.id === oldId)?.references,
      ).toEqual(['draft:retained']);
      expect(
        result.assets.find(asset => asset.id === newId)?.references,
      ).toEqual(
        action === 'update'
          ? ['draft:retained', 'catalog:1']
          : ['draft:retained'],
      );
      expect(result.operations[0].cleanup).toEqual(
        expect.arrayContaining([
          {
            id: oldId,
            assetId: oldId,
            status: 'protected',
            reason: expect.any(String),
          },
        ]),
      );
      expect(result.assets.every(asset => asset.status === 'active')).toBe(
        true,
      );
    } finally {
      await worker.dispose();
    }
  });
  it.each([
    'replaced',
    'deleted',
  ] as const)('does not resurrect old asset catalog holds when a succeeded operation is replayed after the product is %s', async later => {
    const mutation = operation('update', 'succeeded');
    const oldId = 'old-replayed-photo';
    const newId = 'current-photo';
    if (!mutation.preparation.snapshot)
      throw new Error('Missing fixture snapshot');
    mutation.preparation.snapshot.assetIds = [oldId];
    mutation.preparation.snapshot.cleanupAssetIds = [oldId, newId];
    const worker = runtime(join(root, mutation.id));
    try {
      await seeded(worker, mutation);
      await call(worker, {
        command: 'seed',
        assets: [oldId, newId].map(id => ({
          id,
          ownerId: 'owner',
          draftId: 'retained-draft',
          kind: 'photo',
          objectKey: id,
          encryptionKey: 'unused',
          status: 'active',
          revision: 1,
          references: [
            'draft:retained',
            ...(id === newId && later === 'replaced' ? ['catalog:1'] : []),
          ],
        })),
      });
      if (later === 'replaced')
        await call(worker, {
          command: 'product',
          product: {
            image: `/catalog/assets/${newId}/image`,
            imageGallery: JSON.stringify([`/catalog/assets/${newId}/image`]),
            catalogMutationId: 'newer-operation',
            squareRevision: 2,
          },
        });
      else await call(worker, { command: 'removeProduct' });
      const before = await call(worker, { command: 'inspect' });
      const result = await call(worker, {
        command: 'reconcile',
        id: mutation.id,
      });
      expect(result.operations[0].state).toBe('succeeded');
      expect(
        result.assets.map(asset => ({
          id: asset.id,
          references: asset.references,
        })),
      ).toEqual(
        before.assets.map(asset => ({
          id: asset.id,
          references: asset.references,
        })),
      );
      expect(result.products).toEqual(before.products);
    } finally {
      await worker.dispose();
    }
  });
  it('retires an inert prepared crash record without authorizing provider work or local writes', async () => {
    const mutation = operation('create', 'prepared');
    const worker = runtime(join(root, mutation.id));
    try {
      await seeded(worker, mutation);
      const result = await call(worker, {
        command: 'reconcile',
        id: mutation.id,
      });
      expect(result.operations[0]).toMatchObject({
        state: 'failed',
        error: 'inert_operation_retired_reprepare',
      });
      expect(result.products).toEqual([]);
      expect(result.mappings).toEqual([]);
      expect(result.categories).toEqual([]);
    } finally {
      await worker.dispose();
    }
  });
});
