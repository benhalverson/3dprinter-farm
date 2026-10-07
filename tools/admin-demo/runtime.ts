import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DrizzleSQLiteSnapshotJSON,
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
} from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { createRequire } from 'node:module';
// Interactive demo only. Tests use test/integration/adminDemoHarness.ts.
const require = createRequire(import.meta.url);
const {Miniflare, convertV4MiniflareOptions} = createRequire(require.resolve('wrangler/package.json'))('miniflare');
const runtimeOptions = (options: object) => convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options;
import { build } from 'vite';

const { createProviderBoundary } = (await import(
  new URL('./providers.ts', import.meta.url).href
)) as typeof import('./providers');

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Creates isolated production routes backed by real D1/R2 and deterministic provider responses. */
export async function createDemoRuntime(options: { port?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lulu-admin-demo-'));
  let worker: InstanceType<typeof Miniflare> | undefined;
  try {
    const journal = JSON.parse(
      await readFile(
        join(repository, 'drizzle/migrations/meta/_journal.json'),
        'utf8',
      ),
    ) as { entries: { idx: number }[] };
    const last = journal.entries.at(-1)?.idx;
    const snapshot = JSON.parse(
      await readFile(
        join(
          repository,
          `drizzle/migrations/meta/${String(last).padStart(4, '0')}_snapshot.json`,
        ),
        'utf8',
      ),
    ) as DrizzleSQLiteSnapshotJSON;
    const statements = await generateSQLiteMigration(
      await generateSQLiteDrizzleJson({}),
      snapshot,
    );
    const migrationsFolder = join(root, 'generated');
    await mkdir(join(migrationsFolder, 'meta'), { recursive: true });
    await writeFile(
      join(migrationsFolder, '0000_baseline.sql'),
      statements.join('\n--> statement-breakpoint\n'),
    );
    await writeFile(
      join(migrationsFolder, 'meta/_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '6',
            when: 1,
            tag: '0000_baseline',
            breakpoints: true,
          },
        ],
      }),
    );
    await build({
      root: repository,
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: [
          {
            find: resolve(repository, 'lib/auth.ts'),
            replacement: resolve(
              repository,
              'tools/admin-demo/auth-fixture.ts',
            ),
          },
        ],
      },
      plugins: [
        {
          name: 'fixture-worker-wasm',
          enforce: 'pre',
          async resolveId(source, importer) {
            if (
              importer &&
              resolve(dirname(importer), source).replace(/\.ts$/, '') ===
                resolve(repository, 'lib/auth')
            )
              return resolve(repository, 'tools/admin-demo/auth-fixture.ts');
            if (source.endsWith('.wasm') && importer) {
              await copyFile(
                resolve(dirname(importer), source),
                join(root, 'photon.wasm'),
              );
              return { id: './photon.wasm', external: true };
            }
          },
        },
      ],
      build: {
        outDir: join(root, 'bundle'),
        lib: {
          entry: resolve(repository, 'tools/admin-demo/worker.ts'),
          formats: ['es'],
          fileName: () => 'worker.js',
        },
        rollupOptions: { external: ['cloudflare:workers'] },
        minify: false,
      },
    });
    await copyFile(join(root, 'photon.wasm'), join(root, 'bundle/photon.wasm'));
    const providers = createProviderBoundary();
    worker = new Miniflare(runtimeOptions({
      modules: true,
      modulesRoot: join(root, 'bundle'),
      scriptPath: join(root, 'bundle/worker.js'),
      host: '127.0.0.1',
      port: options.port ?? 0,
      modulesRules: [
        { type: 'CompiledWasm', include: ['**/*.wasm'], fallthrough: true },
      ],
      compatibilityDate: '2026-04-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      ...(convertV4MiniflareOptions ? {resourcePersistencePath: join(root, 'storage')} : {d1Persist: join(root, 'd1'), r2Persist: join(root, 'r2')}),
      r2Buckets: ['PHOTO_BUCKET', 'BUCKET'],
      bindings: {
        SLANT_API_V2: 'local-provider-placeholder',
        SLANT_API: 'local-provider-placeholder',
        SLANT_API_V2_BASE_URL: 'https://slant3dapi.com/v2/api/',
        SLANT_PLATFORM_ID: 'platform-demo',
        SQUARE_ENVIRONMENT: 'sandbox',
        SQUARE_ACCESS_TOKEN: 'local-provider-placeholder',
        SQUARE_MERCHANT_ID: 'merchant-demo',
        SQUARE_LOCATION_ID: 'location-demo',
        DOMAIN: 'localhost',
        ENCRYPTION_PASSPHRASE: 'local-fixture-only',
        JWT_SECRET: 'local-fixture-only',
        BETTER_AUTH_SECRET: 'local-fixture-only-secret-32-characters',
      },
      outboundService: providers.providerFetch,
    }));
    await migrate(drizzle(await worker.getD1Database('DB')), {
      migrationsFolder,
    });
    const apiUrl = new URL(await worker.ready);
    apiUrl.hostname = 'localhost';
    providers.setOrigin(apiUrl.origin);
    const seeded = await worker.dispatchFetch(
      new URL('/__fixture/bootstrap', apiUrl),
      {
        method: 'POST',
        headers: { 'x-demo-fixture-token': 'lulu-local-demo' },
      },
    );
    if (!seeded.ok) throw new Error(await seeded.text());
    return {
      worker,
      providers,
      root,
      url: apiUrl,
      async close() {
        await worker?.dispose();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await worker?.dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
