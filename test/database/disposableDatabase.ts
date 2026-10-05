import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from '../../src/db/schema';

const executeFile = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type MigrationReplay = {
  succeeded: boolean;
  output: string;
};

/** Runs a Drizzle CLI command without a shell, preserving diagnostic output. */
async function runDrizzle(
  command: 'generate' | 'migrate',
  config: string,
): Promise<string> {
  try {
    const { stdout, stderr } = await executeFile(
      process.execPath,
      [
        join(repository, 'node_modules/drizzle-kit/bin.cjs'),
        command,
        '--config',
        config,
      ],
      { cwd: repository, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      signal?: string;
    };
    throw new Error(
      `Drizzle ${command} failed (exit=${failure.code ?? 'unknown'}, signal=${failure.signal ?? 'none'}): ${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
      { cause: error },
    );
  }
}

/** Writes a temporary Drizzle configuration pointing exclusively at disposable files. */
async function writeConfig(
  root: string,
  name: string,
  migrations: string,
  databasePath: string,
): Promise<string> {
  const config = join(root, `${name}.config.ts`);
  await writeFile(
    config,
    `export default ${JSON.stringify(
      {
        dialect: 'sqlite',
        schema: join(repository, 'src/db/schema.ts'),
        out: migrations,
        dbCredentials: { url: databasePath },
      },
      null,
      2,
    )};\n`,
  );
  return config;
}

/** Uses Drizzle's standard migrator on a second disposable database to reveal errors hidden by its CLI spinner. */
async function diagnoseMigrationReplay(root: string): Promise<string> {
  const client = createClient({
    url: `file:${join(root, 'history-diagnostic.sqlite')}`,
  });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: join(repository, 'drizzle/migrations'),
    });
    return 'Standard Drizzle migrator replay succeeded; the CLI failure requires separate investigation.';
  } catch (error) {
    return `Standard Drizzle migrator: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    client.close();
  }
}

/** Audits committed migration replay separately; it never rewrites or repairs that history. */
async function auditMigrationReplay(root: string): Promise<MigrationReplay> {
  const config = await writeConfig(
    root,
    'history',
    join(repository, 'drizzle/migrations'),
    join(root, 'history.sqlite'),
  );
  let output: string;
  try {
    output = await runDrizzle('migrate', config);
    // drizzle-kit can print a migration failure while exiting successfully.
    if (output.includes('migrations applied successfully'))
      return { succeeded: true, output };
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
  }
  return {
    succeeded: false,
    output: `${output}\n${await diagnoseMigrationReplay(root)}`,
  };
}

/** Generates and migrates the current schema into a fresh SQLite fixture using Drizzle commands only. */
export async function createDisposableDatabase() {
  const root = await mkdtemp(join(tmpdir(), 'lulu-cart-database-'));
  try {
    const migrationReplay = await auditMigrationReplay(root);
    const databasePath = join(root, 'current-schema.sqlite');
    const config = await writeConfig(
      root,
      'baseline',
      join(root, 'generated'),
      databasePath,
    );
    const generationOutput = await runDrizzle('generate', config);
    const migrationOutput = await runDrizzle('migrate', config);
    if (!migrationOutput.includes('migrations applied successfully')) {
      throw new Error(
        `Generated baseline failed to migrate:\n${generationOutput}\n${migrationOutput}`,
      );
    }
    const client = createClient({ url: `file:${databasePath}` });
    const db = drizzle(client, { schema });
    return {
      root,
      databasePath,
      migrationReplay,
      db,
      /** Closes the real SQLite connection and removes only this fixture's temporary directory. */
      async close() {
        client.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
