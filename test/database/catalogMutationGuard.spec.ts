import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  squareCatalogOperations as legacyOperations,
  squareCatalogMappings as mappings,
  productMutationOperations as mutations,
  productsTable,
} from '../../src/db/schema';
import { noPendingProductMutation } from '../../src/modules/catalogMutationGuard';
import { reserveCatalogOperation } from '../../src/modules/catalogPublicationReservation';
import type { ProductPreparation } from '../../src/modules/productPreparationContracts';
import { createDisposableDatabase } from './disposableDatabase';

type MutationState = typeof mutations.$inferSelect.state;
let fixture: Awaited<ReturnType<typeof createDisposableDatabase>>;
let db: Parameters<typeof reserveCatalogOperation>[0];
let sequence = 0;
beforeAll(async () => {
  fixture = await createDisposableDatabase();
  db = fixture.db as unknown as Parameters<typeof reserveCatalogOperation>[0];
});
afterAll(async () => {
  await fixture?.close();
});

/** Persist all required durable operation fields, including the frozen local recovery projection. */
function operation(
  id: string,
  productId: number,
  state: MutationState,
): typeof mutations.$inferInsert {
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
    snapshot: null,
  };
  return {
    id,
    ownerId: 'owner',
    draftId: `draft-${id}`,
    preparationId: `preparation-${id}`,
    draftRevision: 1,
    action: 'update',
    state,
    preparation,
    payload: '{}',
    environment: 'sandbox',
    merchantId: 'merchant',
    locationId: 'location',
    productId,
    localName: 'Bracket',
    localDescription: 'Frozen description',
    localImage: '',
    localImageGallery: '[]',
    localStl: 'file.stl',
    localPrice: 3,
    localMarkupPercentage: 50,
    localFilamentType: 'PLA',
    localSkuNumber: 'SKU',
    localColor: 'Blue',
    localInPersonPrice: 500,
    localPublicFileServiceId: 'file',
    localSquareRevision: 0,
    localPublishedSnapshot: '{}',
    localCreatedAt: '2026-10-06T00:00:00Z',
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Create an unpublished catalog identity with separate resolved and unresolved operation IDs. */
async function seed(state: MutationState) {
  const identity = `guard-${++sequence}`;
  const [item] = await fixture.db
    .insert(productsTable)
    .values({
      name: 'Bracket',
      description: 'Original',
      stl: 'file.stl',
      squareRevision: 0,
    })
    .returning();
  const [mapping] = await fixture.db
    .insert(mappings)
    .values({
      id: identity,
      productId: item.id,
      catalogId: item.id,
      environment: 'sandbox',
      merchantId: 'merchant',
      locationId: 'location',
      published: 0,
    })
    .returning();
  const priorId = `${identity}-prior`;
  const activeId = `${identity}-active`;
  await fixture.db
    .insert(mutations)
    .values([
      operation(priorId, item.id, 'succeeded'),
      operation(activeId, item.id, state),
    ]);
  return { item, mapping, identity, activeId, priorId };
}

describe('real SQLite serialization between legacy publication and durable admin operations', () => {
  it.each([
    'prepared',
    'pending',
    'item_confirmed',
    'square_confirmed',
    'repair_required',
  ] as const)('keeps legacy activation inert while an admin operation is %s', async state => {
    const { item, mapping, identity, activeId, priorId } = await seed(state);
    const reserved = await reserveCatalogOperation(
      db,
      item,
      mapping,
      'publish',
      '{}',
      'snapshot',
      `${identity}-legacy`,
    );
    expect(reserved).toBeUndefined();
    const legacy = await fixture.db
      .select()
      .from(legacyOperations)
      .where(eq(legacyOperations.id, `${identity}-legacy`))
      .get();
    expect(legacy?.state).toBe('prepared');
    const actual = await fixture.db
      .select()
      .from(mutations)
      .where(eq(mutations.productId, item.id))
      .all();
    expect(actual.map(row => ({ id: row.id, state: row.state }))).toEqual(
      expect.arrayContaining([
        { id: activeId, state },
        { id: priorId, state: 'succeeded' },
      ]),
    );
    expect(
      await fixture.db
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, item.id))
        .get(),
    ).toMatchObject({ description: 'Original', squareRevision: 0 });
  });
  it.each([
    'succeeded',
    'failed',
  ] as const)('releases legacy activation only after the unresolved operation becomes %s', async resolved => {
    const { item, mapping, identity, activeId } = await seed('repair_required');
    expect(
      await reserveCatalogOperation(
        db,
        item,
        mapping,
        'publish',
        '{}',
        'snapshot',
        `${identity}-blocked`,
      ),
    ).toBeUndefined();
    await fixture.db
      .update(mutations)
      .set({ state: resolved, updatedAt: 2 })
      .where(eq(mutations.id, activeId));
    const reserved = await reserveCatalogOperation(
      db,
      item,
      mapping,
      'publish',
      '{}',
      'snapshot',
      `${identity}-retry`,
    );
    expect(reserved).toMatchObject({
      id: `${identity}-retry`,
      state: 'pending',
      mappingId: mapping.id,
    });
    expect(
      await fixture.db
        .select()
        .from(legacyOperations)
        .where(eq(legacyOperations.id, `${identity}-blocked`))
        .get(),
    ).toMatchObject({ state: 'prepared' });
    expect(
      await fixture.db
        .select()
        .from(legacyOperations)
        .where(eq(legacyOperations.id, `${identity}-retry`))
        .get(),
    ).toMatchObject({ state: 'pending' });
  });
  it('guards actual catalog updates and deletions, then permits them after recovery resolves', async () => {
    const { item, activeId } = await seed('square_confirmed');
    const predicate = () =>
      and(eq(productsTable.id, item.id), noPendingProductMutation(db, item.id));
    expect(
      await fixture.db
        .update(productsTable)
        .set({ description: 'Changed', squareRevision: 1 })
        .where(predicate())
        .returning(),
    ).toEqual([]);
    expect(
      await fixture.db.delete(productsTable).where(predicate()).returning(),
    ).toEqual([]);
    expect(
      await fixture.db
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, item.id))
        .get(),
    ).toMatchObject({ description: 'Original', squareRevision: 0 });
    await fixture.db
      .update(mutations)
      .set({ state: 'succeeded' })
      .where(eq(mutations.id, activeId));
    expect(
      await fixture.db
        .update(productsTable)
        .set({ description: 'Changed', squareRevision: 1 })
        .where(predicate())
        .returning(),
    ).toHaveLength(1);
    expect(
      await fixture.db.delete(productsTable).where(predicate()).returning(),
    ).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, item.id))
        .get(),
    ).toBeUndefined();
    expect(
      await fixture.db
        .select()
        .from(mutations)
        .where(eq(mutations.id, activeId))
        .get(),
    ).toMatchObject({ state: 'succeeded', productId: item.id });
  });
});
