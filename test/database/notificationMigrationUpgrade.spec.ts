import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
  type DrizzleSQLiteSnapshotJSON,
} from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Miniflare } from 'miniflare';
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

test('generated notification upgrade preserves actual main0022 data and inert duplicate legacy attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notification-upgrade-'));
  const worker = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("local test")}}',
    d1Databases: ['DB'],
  });
  try {
    const baseline = JSON.parse(
      await readFile('drizzle/migrations/meta/0022_snapshot.json', 'utf8'),
    ) as DrizzleSQLiteSnapshotJSON;
    const current = await generateSQLiteDrizzleJson(schema);
    const db = drizzle(await worker.getD1Database('DB'), { schema });
    await migrate(db, {
      migrationsFolder: await migrationFolder(
        root,
        'baseline',
        await generateSQLiteDrizzleJson({}),
        baseline,
        1,
      ),
    });
    await db
      .insert(schema.users)
      .values({
        id: 'retained',
        name: 'Retained',
        email: 'retained@example.test',
      });
    await db
      .insert(legacyAttempts)
      .values(
        Array.from({ length: 2 }, () => ({
          notificationType: 'order_confirmation',
          recipientEmail: 'legacy@example.test',
          status: 'failed',
          source: 'legacy',
          idempotencyKey: 'duplicate-legacy-key',
        })),
      );
    await migrate(db, {
      migrationsFolder: await migrationFolder(
        root,
        'upgrade',
        baseline,
        current,
        2,
      ),
    });
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
    await worker.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
