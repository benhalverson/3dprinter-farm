import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = join(root, 'wrangler.toml');
const database = '8ea08f02-696c-4410-a690-2bf1fa0333dc';
const migrationArgs = ['d1', 'migrations'];

// Ben specifically approved removing obsolete Stripe data: "i dont have any data
// with stripe get rid of it". Bind that approval to this published migration only.
const approvedStripeMigration = {
  name: '0018_square_catalog.sql',
  sha256: 'b8f0199cbc1991afd193897f916cdfa9b75684a4919da16d6851af34b8d38ca2',
};

/** Match the specifically approved Stripe migration, normalizing checkout line endings. */
export function hasSpecificMigrationApproval(name, contents) {
  return (
    name === approvedStripeMigration.name &&
    createHash('sha256')
      .update(contents.replace(/\r\n/g, '\n'))
      .digest('hex') === approvedStripeMigration.sha256
  );
}

/** Conservatively detect destructive statements in Drizzle-generated migrations. */
export function requiresMigrationApproval(contents) {
  const statements = contents
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '')
    .split(';');
  return statements.some(
    statement =>
      /\b(?:DROP|TRUNCATE)\b/i.test(statement) ||
      /^\s*(?:UPDATE|DELETE|REPLACE)\b/i.test(statement),
  );
}

/** Run the locked Wrangler CLI without interactive input or a shell. */
export function runWrangler(args) {
  const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, CI: 'true', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Wrangler failed (${result.status ?? result.signal})`);
  return result.stdout;
}

/** Parse the pinned CLI's migration list; unknown output fails closed. */
export function pendingMigrations(output, files) {
  if (output.includes('No migrations to apply!') && !output.includes('.sql'))
    return [];
  if (!output.includes('Migrations to be applied:'))
    throw new Error('Unrecognized migration list output');
  const names = [...output.matchAll(/[\w.-]+\.sql\b/g)].map(match => match[0]);
  if (
    !names.length ||
    names.some(
      name => !/^\d{4}_[\w-]+\.sql$/.test(name) || !files.includes(name),
    )
  ) {
    throw new Error('Unknown or missing committed migrations in CLI output');
  }
  return [...new Set(names)];
}

/** Apply committed forward migrations before releasing the production Worker. */
export function deploy({
  run = runWrangler,
  readMigration = name =>
    readFileSync(join(root, 'drizzle/migrations', name), 'utf8'),
  workspace = root,
  args = [],
} = {}) {
  if (args.length)
    throw new Error('Production deploy accepts no target overrides');
  if (process.env.CLOUDFLARE_ENV)
    throw new Error('CLOUDFLARE_ENV must be unset for production deployment');
  const lock = join(workspace, '.deploy-lock');
  mkdirSync(lock);
  try {
    const files = readdirSync(join(workspace, 'drizzle/migrations')).filter(
      name => name.endsWith('.sql'),
    );
    const status = spawnSync(
      'git',
      [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        'drizzle/migrations',
        'wrangler.toml',
      ],
      { cwd: workspace, encoding: 'utf8' },
    );
    if (status.status !== 0 || status.stdout.trim())
      throw new Error(
        'Deploy requires committed migration files and configuration',
      );
    const settings = readFileSync(join(workspace, 'wrangler.toml'), 'utf8');
    const production = settings
      .split('[[d1_databases]]')
      .slice(1)
      .map(section => section.split(/^\[/m)[0])
      .filter(section => /^binding\s*=\s*"DB"\s*$/m.test(section));
    if (
      production.length !== 1 ||
      !new RegExp(`^database_id\\s*=\\s*"${database}"\\s*$`, 'm').test(
        production[0],
      ) ||
      !/^name\s*=\s*"3dprinter-web-api"\s*$/m.test(settings.split(/^\[/m)[0])
    )
      throw new Error('Unexpected production configuration');
    const target = ['DB', '--remote', '--env', '', '--config', config];
    const pending = pendingMigrations(
      run([...migrationArgs, 'list', ...target]),
      files,
    );
    // Published history contains overlapping additions and cannot bootstrap safely.
    if (pending.some(name => Number(name.slice(0, 4)) < 18)) {
      throw new Error(
        'Historical migrations are pending. Reconcile the existing database and migration ledger before deployment; automatic bootstrap is blocked.',
      );
    }
    // Generated migrations may delete existing data. Never infer approval from deploy.
    for (const name of pending) {
      const contents = readMigration(name);
      if (
        requiresMigrationApproval(contents) &&
        !hasSpecificMigrationApproval(name, contents)
      ) {
        throw new Error(
          `Destructive migration ${name} requires specific approval and a separately reviewed migration plan; Worker release blocked.`,
        );
      }
    }
    if (pending.length) run([...migrationArgs, 'apply', ...target]);
    if (
      pendingMigrations(run([...migrationArgs, 'list', ...target]), files)
        .length
    )
      throw new Error('Migrations remain pending; Worker release blocked');
    run(['deploy', '--env', '', '--config', config]);
  } finally {
    rmdirSync(lock);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    deploy({ args: process.argv.slice(2) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
