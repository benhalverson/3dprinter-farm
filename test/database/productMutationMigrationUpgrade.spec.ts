import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DrizzleSQLiteSnapshotJSON,
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
} from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createClient } from '@libsql/client';
import { expect, it } from 'vitest';
import * as schema from '../../src/db/schema';

// Historical projections seed only columns available before the new forward migrations.
const historicalProducts = sqliteTable('products', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  stl: text('stl').notNull(),
  price: real('price').notNull(),
  inPersonPrice: integer('in_person_price_cents'),
  squareRevision: integer('square_revision').notNull(),
});
const historicalDrafts = sqliteTable('product_drafts', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  target: text('target', { mode: 'json' })
    .$type<typeof schema.productDrafts.$inferInsert.target>()
    .notNull(),
  state: text('state', { mode: 'json' })
    .$type<typeof schema.productDrafts.$inferInsert.state>()
    .notNull(),
  revision: integer('revision').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Builds a baseline solely from the published0024 Drizzle snapshot. */
async function baselineFolder(
  root: string,
  snapshot: DrizzleSQLiteSnapshotJSON,
) {
  const statements = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    snapshot,
  );
  const folder = join(root, 'baseline');
  await mkdir(join(folder, 'meta'), { recursive: true });
  await writeFile(
    join(folder, '0000_baseline.sql'),
    statements.join('\n--> statement-breakpoint\n'),
  );
  await writeFile(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [
        {
          idx: 0,
          version: '6',
          when: 1,
          tag: '0000_baseline',
          breakpoints: true,
        },
      ],
    }),
  );
  return folder;
}

it('exact generated0025/0026 upgrade preserves published0024 catalog and draft identities without invented legacy markup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-mutation-upgrade-'));
  const client = createClient({url: 'file::memory:'});
  try {
    const baseline = JSON.parse(
      await readFile('drizzle/migrations/meta/0024_snapshot.json', 'utf8'),
    ) as DrizzleSQLiteSnapshotJSON;
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: await baselineFolder(root, baseline),
    });
    await db.insert(historicalProducts).values({
      id: 7,
      name: 'Legacy bracket',
      description: 'Retained',
      stl: 'legacy.stl',
      price: 11.5,
      inPersonPrice: 799,
      squareRevision: 4,
    });
    const state = {
      answers: { name: 'Saved draft', inPersonPrice: '7.99' },
      history: [{ role: 'user' as const, content: 'Keep this draft' }],
      pendingQuestions: [],
    };
    await db.insert(historicalDrafts).values({
      id: 'saved-draft',
      ownerId: 'owner',
      target: { kind: 'existing', productId: 7 },
      state,
      revision: 8,
      createdAt: 100,
      updatedAt: 200,
    });
    await db.insert(schema.squareCatalogMappings).values({
      id: 'saved-mapping',
      productId: 7,
      catalogId: 7,
      environment: 'sandbox',
      merchantId: 'merchant',
      locationId: 'location',
      itemId: 'existing-square-item',
      variationId: 'existing-variation',
      generation: 4,
      published: 1,
      publishedSnapshot: 'retained-snapshot',
    });
    const journal = JSON.parse(
      await readFile('drizzle/migrations/meta/_journal.json', 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    const entries = journal.entries.filter(
      entry => entry.idx === 25 || entry.idx === 26,
    );
    expect(entries.map(entry => entry.idx)).toEqual([25, 26]);
    const folder = join(root, 'forward');
    await mkdir(join(folder, 'meta'), { recursive: true });
    let prior = baseline;
    for (const entry of entries) {
      const next = JSON.parse(
        await readFile(
          `drizzle/migrations/meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`,
          'utf8',
        ),
      ) as DrizzleSQLiteSnapshotJSON;
      expect(next.prevId).toBe(prior.id);
      const generated = await generateSQLiteMigration(prior, next);
      const exact = await readFile(
        `drizzle/migrations/${entry.tag}.sql`,
        'utf8',
      );
      expect(
        exact
          .split('--> statement-breakpoint')
          .map(statement => statement.trim())
          .filter(Boolean),
      ).toEqual(generated.map(statement => statement.trim()).filter(Boolean));
      await writeFile(join(folder, `${entry.tag}.sql`), exact);
      prior = next;
    }
    await writeFile(
      join(folder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries }),
    );
    await migrate(db, { migrationsFolder: folder });
    await migrate(db, { migrationsFolder: folder });
    const products = await db.select().from(schema.productsTable);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      id: 7,
      name: 'Legacy bracket',
      price: 11.5,
      inPersonPrice: 799,
      squareRevision: 4,
      markupPercentage: null,
      catalogMutationId: null,
    });
    expect(await db.select({id: schema.productDrafts.id, ownerId: schema.productDrafts.ownerId, target: schema.productDrafts.target, revision: schema.productDrafts.revision, state: schema.productDrafts.state, preparation: schema.productDrafts.preparation, createdAt: schema.productDrafts.createdAt, updatedAt: schema.productDrafts.updatedAt}).from(schema.productDrafts)).toEqual([
      expect.objectContaining({
        id: 'saved-draft',
        ownerId: 'owner',
        target: { kind: 'existing', productId: 7 },
        revision: 8,
        state,
        preparation: null,
        createdAt: 100,
        updatedAt: 200,
      }),
    ]);
    expect(await db.select().from(schema.squareCatalogMappings)).toEqual([
      expect.objectContaining({
        id: 'saved-mapping',
        productId: 7,
        itemId: 'existing-square-item',
        variationId: 'existing-variation',
        generation: 4,
        published: 1,
        publishedSnapshot: 'retained-snapshot',
      }),
    ]);
    expect(await db.select().from(schema.productMutationOperations)).toEqual(
      [],
    );
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
