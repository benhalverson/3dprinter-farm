import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { generateSQLiteMigration, type DrizzleSQLiteSnapshotJSON } from 'drizzle-kit/api';

const historyTables = ['order_cancellation_attempts', 'order_events', 'order_notification_attempts', 'order_reconciliation_attempts'];
const readSnapshot = async (version: string) => JSON.parse(await readFile(`drizzle/migrations/meta/${version}_snapshot.json`, 'utf8')) as DrizzleSQLiteSnapshotJSON;

/** Generate three schema transitions, emitted as ONE atomic D1 migration. */
export async function inPersonUpgradePhases() {
  const before = await readSnapshot('0026');
  const after = await readSnapshot('0029');
  const detach = (snapshot: DrizzleSQLiteSnapshotJSON) => {
    const copy = structuredClone(snapshot);
    for (const table of historyTables) copy.tables[table].foreignKeys = {};
    return copy;
  };
  const detachedBefore = detach(before);
  const detachedAfter = detach(after);
  const phases = [
    await generateSQLiteMigration(before, detachedBefore),
    await generateSQLiteMigration(detachedBefore, detachedAfter),
    await generateSQLiteMigration(detachedAfter, after),
  ];
  return phases.map(phase => phase.filter(statement => statement.trim()));
}

export async function inPersonUpgrade() {
  return (await inPersonUpgradePhases()).flat().join('\n--> statement-breakpoint\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile('drizzle/migrations/0029_in_person_sales_atomic.sql', await inPersonUpgrade());
}
