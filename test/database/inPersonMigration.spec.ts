import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
  type DrizzleSQLiteSnapshotJSON,
} from 'drizzle-kit/api';
import { eq, getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Miniflare } from 'miniflare';
import { expect, test } from 'vitest';
import * as schema from '../../src/db/schema';

/** Builds a disposable schema baseline through Drizzle, without replaying broken historical bootstrap migrations. */
async function baselineFolder(root: string) {
  const snapshot = JSON.parse(
    await readFile('drizzle/migrations/meta/0026_snapshot.json', 'utf8'),
  ) as DrizzleSQLiteSnapshotJSON;
  const statements = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    snapshot,
  );
  const folder = join(root, 'baseline');
  await mkdir(join(folder, 'meta'), { recursive: true });
  await writeFile(
    join(folder, '0000_baseline.sql'),
    statements
      .filter(statement => statement.trim())
      .join('\n--> statement-breakpoint\n'),
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
          when: 0,
          tag: '0000_baseline',
          breakpoints: true,
        },
      ],
    }),
  );
  return folder;
}

/** Copies exact committed forward migrations and their generated ledger entries into an isolated folder. */
async function forwardFolder(root: string, tags: string[]) {
  const folder = join(root, tags.join('-'));
  const journal = JSON.parse(
    await readFile('drizzle/migrations/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  await mkdir(join(folder, 'meta'), { recursive: true });
  for (const tag of tags) {
    await writeFile(
      join(folder, `${tag}.sql`),
      await readFile(`drizzle/migrations/${tag}.sql`),
    );
  }
  await writeFile(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({
      ...journal,
      entries: journal.entries.filter(entry => tags.includes(entry.tag)),
    }),
  );
  return folder;
}

test('generated in-person migration preserves catalog, customers and order history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'in-person-upgrade-'));
  const worker = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("probe"); } };',
    compatibilityDate: '2026-04-01',
    d1Databases: { DB: 'in-person-upgrade' },
  });
  try {
    const binding = await worker.getD1Database('DB');
    const db = drizzle(binding as unknown as D1Database, { schema });
    await migrate(db, { migrationsFolder: await baselineFolder(root) });
    await db
      .insert(schema.users)
      .values({ id: 'owner', name: 'Owner', email: 'owner@example.test' });
    await db
      .insert(schema.productsTable)
      .values({
        id: 1,
        name: 'Retained',
        description: 'Product',
        stl: 'file',
        price: 5,
        inPersonPrice: 500,
      });
    await db
      .insert(schema.ordersTable)
      .values({
        id: 1,
        userId: 'owner',
        orderNumber: 'old',
        fileURL: 'file',
        shipToName: 'Owner',
        shipToStreet1: 'Street',
        shipToCity: 'City',
        shipToState: 'CA',
        shipToZip: '90001',
        shipToCountryISO: 'US',
      });
    await db
      .insert(schema.orderEventsTable)
      .values({ orderId: 1, type: 'retained', dedupeKey: 'retained' });
    await db
      .insert(schema.orderCancellationAttemptsTable)
      .values({ orderId: 1, finalStatus: 'blocked' });
    await db
      .insert(schema.orderReconciliationAttemptsTable)
      .values({
        orderId: 1,
        triggerSource: 'test',
        startingState: 'paid',
        resultStatus: 'retained',
      });
    await db
      .insert(schema.orderNotificationAttemptsTable)
      .values({
        orderId: 1,
        notificationType: 'paid',
        recipientEmail: 'owner@example.test',
        status: 'pending',
        source: 'square',
        idempotencyKey: 'retained',
      });
    await migrate(db, {
      migrationsFolder: await forwardFolder(root, [
        '0027_in_person_detach_history',
        '0028_in_person_sales',
        '0029_in_person_restore_history',
      ]),
    });
    expect((await db.select().from(schema.users))[0].id).toBe('owner');
    expect((await db.select().from(schema.productsTable))[0].name).toBe(
      'Retained',
    );
    expect((await db.select().from(schema.ordersTable))[0].orderNumber).toBe(
      'old',
    );
    for (const table of [
      schema.orderEventsTable,
      schema.orderCancellationAttemptsTable,
      schema.orderReconciliationAttemptsTable,
      schema.orderNotificationAttemptsTable,
    ])
      expect(await db.select().from(table)).toHaveLength(1);
    await db.delete(schema.ordersTable).where(eq(schema.ordersTable.id, 1));
    for (const table of [
      schema.orderEventsTable,
      schema.orderCancellationAttemptsTable,
      schema.orderReconciliationAttemptsTable,
      schema.orderNotificationAttemptsTable,
    ])
      expect(await db.select().from(table)).toHaveLength(0);
    await db
      .insert(schema.ordersTable)
      .values({
        orderNumber: 'QR-new',
        source: 'qr',
        fulfillmentType: 'in_person',
      });
    expect(
      (
        await db
          .select()
          .from(schema.ordersTable)
          .where(eq(schema.ordersTable.orderNumber, 'QR-new'))
      )[0].userId,
    ).toBeNull();
  } finally {
    await worker.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
