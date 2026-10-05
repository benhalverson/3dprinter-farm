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
import { Miniflare } from 'miniflare';
import { expect, test } from 'vitest';
import * as schema from '../../src/db/schema';

/** Copy the exact committed forward artifact and its journal entry, without modifying SQL. */
async function publishedUpgrade(root: string) {
  const tag = '0024_budget_alerts';
  const journal = JSON.parse(
    await readFile('drizzle/migrations/meta/_journal.json', 'utf8'),
  );
  const entry = journal.entries.find(
    (item: { tag: string }) => item.tag === tag,
  );
  expect(entry?.idx).toBe(24);
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

test('generated0024 preserves published0023 reservations and replay on D1 SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-upgrade-'));
  const worker = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("local test")}}',
    d1Databases: ['DB'],
  });
  try {
    const baseline = JSON.parse(
      await readFile('drizzle/migrations/meta/0023_snapshot.json', 'utf8'),
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
    const reservation = {
      id: 'retained',
      month: '2026-09',
      sessionId: 'session',
      runId: 'run',
      invocation: 0,
      model: 'model',
      priceVersion: 'old',
      inputRate: 1,
      outputRate: 2,
      maximum: 300,
      charged: 300,
      status: 'reserved',
    };
    await db.insert(schema.reservations).values(reservation);
    await db
      .insert(schema.starts)
      .values({ id: 'start', visitor: 'visitor', at: 123 });
    const snapshot = JSON.parse(
      await readFile('drizzle/migrations/meta/0024_snapshot.json', 'utf8'),
    ) as DrizzleSQLiteSnapshotJSON;
    expect(snapshot.prevId).toBe(baseline.id);
    expect(snapshot.tables).toEqual(current.tables);
    for (const [name, table] of Object.entries(baseline.tables))
      expect(current.tables[name]).toEqual(table);
    const generated = await generateSQLiteMigration(baseline, current);
    expect(
      (await readFile('drizzle/migrations/0024_budget_alerts.sql', 'utf8'))
        .split('--> statement-breakpoint')
        .map(s => s.trim()),
    ).toEqual(generated.map(s => s.trim()));
    const folder = await publishedUpgrade(root);
    await migrate(db, { migrationsFolder: folder });
    await db
      .insert(schema.budgetAlerts)
      .values({
        id: '2026-09:50',
        month: '2026-09',
        threshold: 50,
        charged: 300,
        exhausted: false,
        attempts: 1,
        nextAttempt: 456,
        lease: 'lease',
        messageId: 'ack',
      });
    await migrate(db, { migrationsFolder: folder });
    expect(await db.select().from(schema.reservations)).toEqual([
      { ...reservation, inputTokens: null, outputTokens: null },
    ]);
    expect(await db.select().from(schema.starts)).toEqual([
      { id: 'start', visitor: 'visitor', at: 123 },
    ]);
    expect((await db.select().from(schema.budgetAlerts))[0]).toMatchObject({
      messageId: 'ack',
      lease: 'lease',
      attempts: 1,
    });
  } finally {
    await worker.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
