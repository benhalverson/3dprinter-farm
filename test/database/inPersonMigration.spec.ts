import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { inPersonUpgrade, inPersonUpgradePhases } from '../../tools/migrations/in-person-upgrade';
import * as schema from '../../src/db/schema';

const baselineOrders = sqliteTable('ordersTable',{id:integer('id').primaryKey(),userId:text('user_id'),orderNumber:text('order_number').notNull(),fileURL:text('file_url'),shipToName:text('ship_to_name'),shipToStreet1:text('ship_to_street_1'),shipToCity:text('ship_to_city'),shipToState:text('ship_to_state'),shipToZip:text('ship_to_zip'),shipToCountryISO:text('ship_to_country_iso')});
const legacyOrder = (id: number) => ({ id, userId: 'owner', orderNumber: `legacy-${id}`, fileURL: 'file', shipToName: 'Owner', shipToStreet1: 'Street', shipToCity: 'City', shipToState: 'CA', shipToZip: '90001', shipToCountryISO: 'US' });

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
      .insert(baselineOrders)
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
    const history = [schema.orderEventsTable,schema.orderCancellationAttemptsTable,schema.orderReconciliationAttemptsTable,schema.orderNotificationAttemptsTable];
    const originalHistory = await Promise.all(history.map(table => db.select().from(table)));
    const retained = async () => {
      expect((await db.select().from(schema.users))[0].id).toBe('owner');
      expect((await db.select().from(schema.productsTable))[0].name).toBe('Retained');
      for (const [index, table] of history.entries()) expect(await db.select().from(table)).toEqual(originalHistory[index]);
    };
    const upgrade = await forwardFolder(root, ['0029_in_person_sales_atomic']);
    const filename = join(upgrade, '0029_in_person_sales_atomic.sql');
    const generated = await readFile(filename, 'utf8');
    expect(generated).toBe(await inPersonUpgrade());
    const phases = await inPersonUpgradePhases();
    // A fault after every internal transition must roll back the WHOLE file.
    // Repeat the last generated statement to force an error without authored SQL.
    for (let phase = 0; phase < phases.length; phase++) {
      const prefix = phases.slice(0, phase + 1).flat();
      await writeFile(filename, [...prefix, prefix.at(-1)!].join('\n--> statement-breakpoint\n'));
      await expect(migrate(db, { migrationsFolder: upgrade })).rejects.toThrow();
      await retained();
      await expect(db.insert(schema.orderEventsTable).values({orderId: 9999, type: 'orphan'})).rejects.toThrow();
      await db.insert(baselineOrders).values(legacyOrder(100 + phase));
      await db.insert(schema.orderEventsTable).values({orderId: 100 + phase, type: 'after-rollback'});
      await db.delete(baselineOrders).where(eq(baselineOrders.id, 100 + phase));
      await retained();
    }
    await writeFile(filename, generated);
    // Old application writes/updates/deletions race the single D1 transaction.
    // Every write must survive exactly once or cascade with its deleted parent.
    await Promise.all([
      migrate(db, { migrationsFolder: upgrade }),
      ...Array.from({length: 12}, async (_, index) => {
        const id = 200 + index;
        await db.batch([
          db.insert(baselineOrders).values(legacyOrder(id)),
          db.insert(schema.orderEventsTable).values({orderId: id, type: 'concurrent', dedupeKey: `concurrent-${id}`}),
          db.update(baselineOrders).set({orderNumber: `updated-${id}`}).where(eq(baselineOrders.id, id)),
        ]);
        if (index % 2 === 0) await db.delete(baselineOrders).where(eq(baselineOrders.id, id));
      }),
    ]);
    // Retrying after a lost successful response is a ledger-backed no-op.
    await migrate(db, { migrationsFolder: upgrade });
    for (let index = 0; index < 12; index++) {
      const id = 200 + index;
      const rows = await db.select().from(baselineOrders).where(eq(baselineOrders.id, id));
      const events = await db.select().from(schema.orderEventsTable).where(eq(schema.orderEventsTable.orderId, id));
      expect(rows).toHaveLength(index % 2);
      expect(events).toHaveLength(index % 2);
      if (rows.length) expect(rows[0].orderNumber).toBe(`updated-${id}`);
      await db.delete(baselineOrders).where(eq(baselineOrders.id, id));
    }
    await retained();
    await expect(db.insert(schema.orderEventsTable).values({orderId: 9999, type: 'orphan'})).rejects.toThrow();
    // Downstream draft branches may add more schema columns; exercise their
    // exact migrations too, while the frozen pre-upgrade fixture stays valid.
    const journal = JSON.parse(await readFile('drizzle/migrations/meta/_journal.json', 'utf8'));
    const later = journal.entries.filter((entry: {idx: number}) => entry.idx > 29).map((entry: {tag: string}) => entry.tag);
    if (later.length) await migrate(db, {migrationsFolder: await forwardFolder(root, later)});
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


test('Wrangler applies the atomic upgrade and its ledger together, including failure and retry', async () => {
  // Never open Wrangler's persisted internal SQLite tables with a different
  // workerd version than the CLI uses (the direct dev dependency may differ).
  const require = createRequire(import.meta.url);
  const {Miniflare: WranglerMiniflare} = createRequire(require.resolve('wrangler/package.json'))('miniflare') as {Miniflare: typeof Miniflare};
  const root = await mkdtemp(join(tmpdir(), 'in-person-wrangler-'));
  const persist = join(root, 'state');
  const options = {modules: true, script: 'export default { fetch() { return new Response("probe"); } };', compatibilityDate: '2026-04-01', d1Databases: {DB: 'atomic-upgrade-test'}, d1Persist: join(persist, 'v3/d1')};
  let worker = new WranglerMiniflare(options);
  try {
    let db = drizzle(await worker.getD1Database('DB') as unknown as D1Database, {schema});
    await migrate(db, {migrationsFolder: await baselineFolder(root)});
    await db.insert(schema.users).values({id: 'owner', name: 'Owner', email: 'owner@example.test'});
    await db.insert(baselineOrders).values(legacyOrder(1));
    await db.insert(schema.orderEventsTable).values({orderId: 1, type: 'retained'});
    await worker.dispose();
    const folder = await forwardFolder(root, ['0029_in_person_sales_atomic']);
    const filename = join(folder, '0029_in_person_sales_atomic.sql');
    const generated = await readFile(filename, 'utf8');
    const phases = await inPersonUpgradePhases();
    const config = join(root, 'wrangler.json');
    await writeFile(config, JSON.stringify({name: 'atomic-upgrade-test', compatibility_date: '2026-04-01', d1_databases: [{binding: 'DB', database_name: 'atomic-upgrade-test', database_id: 'atomic-upgrade-test', migrations_dir: folder}]}));
    const apply = () => promisify(execFile)(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', persist], {env: {...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(root, 'logs')}});
    await writeFile(filename, generated + '\n--> statement-breakpoint\n' + phases.flat().at(-1));
    await expect(apply()).rejects.toThrow();
    worker = new WranglerMiniflare(options);
    db = drizzle(await worker.getD1Database('DB') as unknown as D1Database, {schema});
    expect(await db.select().from(baselineOrders)).toHaveLength(1);
    expect(await db.select().from(schema.orderEventsTable)).toHaveLength(1);
    await expect(db.insert(schema.orderEventsTable).values({orderId: 9999, type: 'orphan'})).rejects.toThrow();
    await worker.dispose();
    await writeFile(filename, generated);
    await apply();
    expect((await apply()).stdout).toContain('No migrations to apply');
    worker = new WranglerMiniflare(options);
    db = drizzle(await worker.getD1Database('DB') as unknown as D1Database, {schema});
    expect(await db.select().from(baselineOrders)).toHaveLength(1);
    expect(await db.select().from(schema.orderEventsTable)).toHaveLength(1);
    await db.delete(baselineOrders).where(eq(baselineOrders.id, 1));
    expect(await db.select().from(schema.orderEventsTable)).toHaveLength(0);
    await db.insert(baselineOrders).values({id: 2, orderNumber: 'nullable'});
  } finally {
    await worker.dispose();
    await rm(root, {recursive: true, force: true});
  }
}, 60000);
