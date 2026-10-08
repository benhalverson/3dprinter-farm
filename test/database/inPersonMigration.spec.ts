import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { expect, test } from 'vitest';
import { migrationArtifact, mockD1 } from './migrationContract';

// Artifact and adapter contract checks only, not migration execution guarantees.
for (const index of [29]) {
  test(`migration ${index} matches generated artifacts and delegates to mocked D1`, async () => {
    const artifact = await migrationArtifact(index);
    try {
      const boundary = mockD1();
      const db = drizzle(boundary.binding);
      await migrate(db, { migrationsFolder: artifact.root });
      expect(boundary.batch).toHaveBeenCalledTimes(1);
      const submitted = boundary.batch.mock.calls[0][0] as { query: string }[];
      expect(submitted.slice(0, -1).map(item => item.query.trim())).toEqual(
        artifact.statements,
      );
      expect(submitted.at(-1)?.query).toContain('__drizzle_migrations');
      boundary.batch.mockClear();
      boundary.raw.mockResolvedValue([
        [1, 'recorded-hash', artifact.entry.when],
      ]);
      await migrate(db, { migrationsFolder: artifact.root });
      expect(boundary.batch).not.toHaveBeenCalled();
    } finally {
      await artifact.close();
    }
  });
  test(`migration ${index} propagates a mocked D1 batch failure`, async () => {
    const artifact = await migrationArtifact(index);
    try {
      const boundary = mockD1();
      boundary.batch.mockRejectedValue(new Error('controlled_d1_failure'));
      await expect(
        migrate(drizzle(boundary.binding), { migrationsFolder: artifact.root }),
      ).rejects.toThrow('controlled_d1_failure');
    } finally {
      await artifact.close();
    }
  });
}
