import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
  type DrizzleSQLiteSnapshotJSON,
} from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Miniflare } from 'miniflare';
import { expect, test } from 'vitest';
import * as schema from '../../src/db/schema';

// Only the pre-0021 columns needed to seed an existing online order.
const baselineOrders = sqliteTable('ordersTable', {
  id: integer('id').primaryKey(),
  userId: text('user_id').notNull(),
  orderNumber: text('order_number').notNull(),
  fileURL: text('file_url').notNull(),
  shipToName: text('ship_to_name').notNull(),
  shipToStreet1: text('ship_to_street_1').notNull(),
  shipToCity: text('ship_to_city').notNull(),
  shipToState: text('ship_to_state').notNull(),
  shipToZip: text('ship_to_zip').notNull(),
  shipToCountryISO: text('ship_to_country_iso').notNull(),
});

/** Builds a disposable schema baseline through Drizzle, without replaying broken historical bootstrap migrations. */
async function baselineFolder(root: string) {
  const snapshot = JSON.parse(
    await readFile('drizzle/migrations/meta/0020_snapshot.json', 'utf8'),
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

test('committed Square increments preserve real D1 orders, dependent history and payment identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'square-d1-upgrade-'));
  const worker = new Miniflare({
    modules: true,
    script:
      'export default { fetch() { return new Response("migration probe"); } };',
    compatibilityDate: '2026-04-01',
    d1Databases: { DB: 'square-d1-upgrade' },
  });
  try {
    const binding = await worker.getD1Database('DB');
    const db = drizzle(binding as unknown as D1Database, { schema });
    await migrate(db, { migrationsFolder: await baselineFolder(root) });
    await db.insert(schema.users).values({
      id: 'upgrade-owner',
      name: 'Owner',
      email: 'upgrade@example.test',
    });
    await db.insert(baselineOrders).values({
      id: 700,
      userId: 'upgrade-owner',
      orderNumber: 'EXISTING-ORDER',
      fileURL: 'https://example.test/file',
      shipToName: 'Owner',
      shipToStreet1: '10 Test Street',
      shipToCity: 'Test',
      shipToState: 'CA',
      shipToZip: '90000',
      shipToCountryISO: 'US',
    });
    await db.insert(schema.categoryTable).values({
      categoryName: 'Retained category',
      normalizedKey: 'retained-category',
    });
    await migrate(db, {
      migrationsFolder: await forwardFolder(root, [
        '0021_square_online_checkout',
      ]),
    });
    expect(
      (await db.select().from(schema.ordersTable))[0].paymentStatus,
    ).toBeNull();
    await db.insert(schema.checkoutQuotes).values({
      id: 'upgrade-quote',
      ownerId: 'upgrade-owner',
      cartId: 'upgrade-cart',
      inputHash: 'immutable-hash',
      encryptedSnapshot: 'retained-ciphertext',
      createdAt: 1,
      expiresAt: 999999,
    });
    await db.batch([
      db
        .update(schema.checkoutQuotes)
        .set({ consumedAttemptId: 'upgrade-attempt' })
        .where(eq(schema.checkoutQuotes.id, 'upgrade-quote')),
      db.insert(schema.checkoutAttempts).values({
        id: 'upgrade-attempt',
        ownerId: 'upgrade-owner',
        cartId: 'upgrade-cart',
        quoteId: 'upgrade-quote',
        requestKey: 'upgrade-request',
        snapshot: '{}',
        customerEmail: 'upgrade@example.test',
        merchantId: 'merchant',
        locationId: 'location',
        createdAt: 1,
      }),
    ]);
    await db
      .update(schema.ordersTable)
      .set({
        squareOrderId: 'square-order',
        squarePaymentId: 'square-payment',
        checkoutAttemptId: 'upgrade-attempt',
        itemSnapshot: 'immutable-items',
        customerSnapshot: 'immutable-address',
        paymentStatus: 'paid',
        fulfillmentState: 'drafted',
      })
      .where(eq(schema.ordersTable.id, 700));
    await db.insert(schema.orderEventsTable).values({
      orderId: 700,
      type: 'square_payment_verified',
      dedupeKey: 'square-paid:square-payment',
      detail: 'retained event',
    });
    await db.insert(schema.orderNotificationAttemptsTable).values({
      orderId: 700,
      notificationType: 'paid',
      recipientEmail: 'upgrade@example.test',
      status: 'pending',
      source: 'square',
      idempotencyKey: 'retained-notification',
    });
    await db.insert(schema.orderCancellationAttemptsTable).values({
      orderId: 700,
      reason: 'retained operator evidence',
      finalStatus: 'blocked',
    });
    const cleanup = await forwardFolder(root, ['0022_square_order_storage']);
    await migrate(db, { migrationsFolder: cleanup });
    await migrate(db, { migrationsFolder: cleanup });
    expect((await db.select().from(schema.ordersTable))[0]).toMatchObject({
      orderNumber: 'EXISTING-ORDER',
      squareOrderId: 'square-order',
      squarePaymentId: 'square-payment',
      checkoutAttemptId: 'upgrade-attempt',
      paymentStatus: 'paid',
      fulfillmentState: 'drafted',
      itemSnapshot: 'immutable-items',
      customerSnapshot: 'immutable-address',
    });
    expect((await db.select().from(schema.orderEventsTable))[0].detail).toBe(
      'retained event',
    );
    expect(
      (await db.select().from(schema.orderNotificationAttemptsTable))[0]
        .idempotencyKey,
    ).toBe('retained-notification');
    expect(
      (await db.select().from(schema.orderCancellationAttemptsTable))[0].reason,
    ).toBe('retained operator evidence');
    expect((await db.select().from(schema.checkoutQuotes))[0]).toMatchObject({
      encryptedSnapshot: 'retained-ciphertext',
      consumedAttemptId: 'upgrade-attempt',
    });
    expect(
      (await db.select().from(schema.checkoutAttempts))[0].requestKey,
    ).toBe('upgrade-request');
    expect(
      (await db.select().from(schema.categoryTable))[0].normalizedKey,
    ).toBe('retained-category');
    await expect(
      db
        .insert(schema.orderEventsTable)
        .values({ orderId: 999999, type: 'orphan' }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.orderEventsTable).values({
        orderId: 700,
        type: 'duplicate',
        dedupeKey: 'square-paid:square-payment',
      }),
    ).rejects.toThrow();
  } finally {
    await worker.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
