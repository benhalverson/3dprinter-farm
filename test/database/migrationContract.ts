import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSQLiteMigration } from 'drizzle-kit/api';
import { expect, vi } from 'vitest';
import { inPersonUpgrade } from '../../tools/migrations/in-person-upgrade';

/** Scripted D1 boundary only: no SQL is executed and no database is opened. */
export function mockD1() {
  const raw = vi.fn().mockResolvedValue([]);
  const run = vi.fn().mockResolvedValue({ success: true, results: [] });
  const prepare = vi.fn((query: string) => {
    const statement = {
      query,
      bind: vi.fn(),
      raw,
      run,
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    statement.bind.mockReturnValue(statement);
    return statement;
  });
  const batch = vi.fn(async (statements: unknown[]) =>
    statements.map(() => ({ success: true, results: [] })),
  );
  return {
    binding: { prepare, batch } as unknown as D1Database,
    prepare,
    batch,
    raw,
  };
}

export async function migrationArtifact(index: number) {
  const journal = JSON.parse(
    await readFile('drizzle/migrations/meta/_journal.json', 'utf8'),
  );
  const entry = journal.entries.find(
    (item: { idx: number }) => item.idx === index,
  );
  if (!entry) throw new Error(`Missing migration ${index}`);
  const prior = journal.entries[journal.entries.indexOf(entry) - 1];
  const snapshot = async (idx: number) =>
    JSON.parse(
      await readFile(
        `drizzle/migrations/meta/${String(idx).padStart(4, '0')}_snapshot.json`,
        'utf8',
      ),
    );
  const before = await snapshot(prior.idx);
  const after = await snapshot(index);
  expect(after.prevId).toBe(before.id);
  const source = await readFile(`drizzle/migrations/${entry.tag}.sql`, 'utf8');
  const generated =
    index === 29
      ? await inPersonUpgrade()
      : (await generateSQLiteMigration(before, after)).join(
          '\n--> statement-breakpoint\n',
        );
  const statements = (value: string) =>
    value
      .split('--> statement-breakpoint')
      .map(item => item.trim())
      .filter(Boolean);
  expect(statements(source)).toEqual(statements(generated));
  const root = await mkdtemp(join(tmpdir(), 'migration-contract-'));
  await mkdir(join(root, 'meta'));
  await writeFile(join(root, `${entry.tag}.sql`), source);
  await writeFile(
    join(root, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: [entry] }),
  );
  return {
    root,
    entry,
    statements: statements(source),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
