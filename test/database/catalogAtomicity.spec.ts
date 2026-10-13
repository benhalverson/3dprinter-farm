import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  categoryTable,
  productsTable,
  productsToCategories,
} from '../../src/db/schema';
import {
  createCatalogItem,
  saveCatalogItemWithCategories,
} from '../../src/modules/catalogPublication';
import { createDisposableDatabase } from './disposableDatabase';
let fixture: Awaited<ReturnType<typeof createDisposableDatabase>>;
let db: Parameters<typeof createCatalogItem>[0];
beforeAll(async () => {
  fixture = await createDisposableDatabase();
  db = fixture.db as unknown as typeof db;
  await fixture.db.insert(categoryTable).values([
    { categoryId: 101, categoryName: 'One' },
    { categoryId: 102, categoryName: 'Two' },
  ]);
});
afterAll(async () => {
  await fixture?.close();
});
test('secondary foreign-key failure rolls back product creation and retry creates exactly one item', async () => {
  const values = {
    name: 'Create fixture',
    description: 'Original',
    stl: 'file',
    categoryId: 101,
  };
  await expect(createCatalogItem(db, values, [101, 999999])).rejects.toThrow();
  expect(await fixture.db.select().from(productsTable)).toHaveLength(0);
  expect(await fixture.db.select().from(productsToCategories)).toHaveLength(0);
  const created = await createCatalogItem(db, values, [102, 101]);
  expect(created.name).toBe('Create fixture');
  expect(
    (
      await fixture.db
        .select()
        .from(productsToCategories)
        .where(eq(productsToCategories.productId, created.id))
        .orderBy(productsToCategories.orderIndex)
    ).map(link => link.categoryId),
  ).toEqual([102, 101]);
});
test('link insertion failure rolls back deletion and values; a stale update cannot replace newer categories', async () => {
  const current = await createCatalogItem(
    db,
    {
      name: 'Update fixture',
      description: 'Original',
      stl: 'file',
      categoryId: 101,
    },
    [101],
  );
  await expect(
    saveCatalogItemWithCategories(db, current, { name: 'Failed' }, [999999]),
  ).rejects.toThrow();
  expect(
    (
      await fixture.db
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, current.id))
    )[0].name,
  ).toBe('Update fixture');
  expect(
    (
      await fixture.db
        .select()
        .from(productsToCategories)
        .where(eq(productsToCategories.productId, current.id))
    ).map(link => link.categoryId),
  ).toEqual([101]);
  await saveCatalogItemWithCategories(db, current, { name: 'Newer' }, [102]);
  await expect(
    saveCatalogItemWithCategories(db, current, { name: 'Stale' }, [101]),
  ).rejects.toMatchObject({ code: 'catalog_changed_retry' });
  expect(
    (
      await fixture.db
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, current.id))
    )[0].name,
  ).toBe('Newer');
  expect(
    (
      await fixture.db
        .select()
        .from(productsToCategories)
        .where(eq(productsToCategories.productId, current.id))
    ).map(link => link.categoryId),
  ).toEqual([102]);
});
