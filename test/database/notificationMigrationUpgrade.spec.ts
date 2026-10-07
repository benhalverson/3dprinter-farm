import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
  type DrizzleSQLiteSnapshotJSON,
} from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createClient } from '@libsql/client';
import { expect, test } from 'vitest';
import * as schema from '../../src/db/schema';

const legacyAttempts = sqliteTable('order_notification_attempts', {
  notificationType: text('notification_type').notNull(),
  recipientEmail: text('recipient_email').notNull(),
  status: text('status').notNull(),
  source: text('source').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString()),
});

const legacyOrders = sqliteTable('ordersTable', {
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
  squarePaymentId: text('square_payment_id'),
  paymentStatus: text('payment_status'),
  slantStatus: text('slant_status'),
});

/** Copy the exact committed forward artifact and its journal entry, without modifying SQL. */
async function publishedUpgrade(root: string) {
  const tag = '0023_order_email_lifecycle';
  const journal = JSON.parse(
    await readFile('drizzle/migrations/meta/_journal.json', 'utf8'),
  );
  const entry = journal.entries.find(
    (item: { tag: string }) => item.tag === tag,
  );
  expect(entry?.idx).toBe(23);
  const directory = join(root, 'published');
  await mkdir(join(directory, 'meta'), { recursive: true });
  await writeFile(
    join(directory, `${tag}.sql`),
    await readFile(`drizzle/migrations/${tag}.sql`),
  );
  await writeFile(
    join(directory, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: [entry] }),
  );
  return directory;
}

/** Materialize only Drizzle-generated statements in a disposable migration folder. */
async function migrationFolder(
  root: string,
  name: string,
  before: DrizzleSQLiteSnapshotJSON,
  after: DrizzleSQLiteSnapshotJSON,
  when: number,
) {
  const statements = await generateSQLiteMigration(before, after);
  const directory = join(root, name);
  await mkdir(join(directory, 'meta'), { recursive: true });
  await writeFile(
    join(directory, '0000_upgrade.sql'),
    statements.join('\n--> statement-breakpoint\n'),
  );
  await writeFile(
    join(directory, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [
        { idx: 0, version: '6', when, tag: '0000_upgrade', breakpoints: true },
      ],
    }),
  );
  return directory;
}

test('exact published0023 preserves main0022 data and legacy attempts across upgrade and replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notification-upgrade-'));
  const client = createClient({url: 'file::memory:'});
  try {
    const baseline = JSON.parse(
      await readFile('drizzle/migrations/meta/0022_snapshot.json', 'utf8'),
    ) as DrizzleSQLiteSnapshotJSON;
    const current = JSON.parse(
      await readFile('drizzle/migrations/meta/0023_snapshot.json', 'utf8'),
    ) as DrizzleSQLiteSnapshotJSON;
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: await migrationFolder(
        root,
        'baseline',
        await generateSQLiteDrizzleJson({}),
        baseline,
        1,
      ),
    });
    await db.insert(schema.users).values({
      id: 'retained',
      name: 'Retained',
      email: 'retained@example.test',
    });
    await db.insert(legacyAttempts).values(
      Array.from({ length: 2 }, () => ({
        notificationType: 'order_confirmation',
        recipientEmail: 'legacy@example.test',
        status: 'failed',
        source: 'legacy',
        idempotencyKey: 'duplicate-legacy-key',
      })),
    );
    await db.insert(legacyOrders).values({
      id: 700,
      userId: 'retained',
      orderNumber: 'RETAINED',
      fileURL: 'private-file',
      shipToName: 'Owner',
      shipToStreet1: 'Test street',
      shipToCity: 'Test city',
      shipToState: 'CA',
      shipToZip: '90000',
      shipToCountryISO: 'US',
      squarePaymentId: 'retained-payment',
      paymentStatus: 'paid',
      slantStatus: 'SHIPPED',
    });
    await db.insert(schema.orderEventsTable).values({
      orderId: 700,
      type: 'square_payment_verified',
      dedupeKey: 'retained-event',
      source: 'square',
      actor: 'square',
    });
    const published = JSON.parse(
      await readFile('drizzle/migrations/meta/0023_snapshot.json', 'utf8'),
    ) as DrizzleSQLiteSnapshotJSON;
    expect(published.prevId).toBe(baseline.id);
    expect(published.tables).toEqual(current.tables);
    const sql = await readFile(
      'drizzle/migrations/0023_order_email_lifecycle.sql',
      'utf8',
    );
    const generated = await generateSQLiteMigration(baseline, current);
    expect(
      sql.split('--> statement-breakpoint').map(statement => statement.trim()),
    ).toEqual(generated.map(statement => statement.trim()));
    const folder = await publishedUpgrade(root);
    await migrate(db, { migrationsFolder: folder });
    await migrate(db, { migrationsFolder: folder });
    expect((await db.select({id: schema.ordersTable.id, squarePaymentId: schema.ordersTable.squarePaymentId, paymentStatus: schema.ordersTable.paymentStatus, slantStatus: schema.ordersTable.slantStatus, slantEventKey: schema.ordersTable.slantEventKey}).from(schema.ordersTable))[0]).toMatchObject({
      id: 700,
      squarePaymentId: 'retained-payment',
      paymentStatus: 'paid',
      slantStatus: 'SHIPPED',
      slantEventKey: null,
    });
    expect((await db.select().from(schema.orderEventsTable))[0].dedupeKey).toBe(
      'retained-event',
    );
    expect((await db.select().from(schema.users))[0].id).toBe('retained');
    const legacy = await db
      .select()
      .from(schema.orderNotificationAttemptsTable);
    expect(legacy).toHaveLength(2);
    expect(
      legacy.every(row => row.deliveryKey === null && row.claimToken === null),
    ).toBe(true);
    const intent = {
      notificationType: 'admin_failure_alert',
      recipientEmail: 'admin@example.test',
      status: 'pending',
      source: 'notifications',
      idempotencyKey: 'new',
      deliveryKey: 'new',
    };
    await db.insert(schema.orderNotificationAttemptsTable).values(intent);
    await expect(
      db.insert(schema.orderNotificationAttemptsTable).values(intent),
    ).rejects.toThrow();
    for (const [name, table] of Object.entries(baseline.tables)) {
      if (!['ordersTable', 'order_notification_attempts'].includes(name))
        expect(current.tables[name]).toEqual(table);
    }
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
