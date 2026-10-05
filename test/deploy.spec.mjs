import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  deploy as productionDeploy,
  pendingMigrations,
  requiresMigrationApproval,
} from '../tools/deploy.mjs';

/** Exercise deploy control flow with simulated non-destructive migration contents. */
function deploy(options) {
  return productionDeploy({ readMigration: () => '', ...options });
}

const none = '? No migrations to apply!';
const pending = 'Migrations to be applied:\n� 0018_square_catalog.sql �';

test('generated additive foreign keys do not require destructive approval', () => {
  const catalog = readFileSync(
    'drizzle/migrations/0018_square_catalog.sql',
    'utf8',
  );
  const additive = catalog.split('ALTER TABLE')[0];
  assert.ok(additive.includes('ON UPDATE no action'));
  assert.equal(requiresMigrationApproval(additive), false);
  assert.equal(requiresMigrationApproval(catalog), true);
});

test('no pending migrations releases only after both checks', () => {
  const calls = [];
  deploy({
    run: args => {
      calls.push(args);
      return none;
    },
  });
  assert.deepEqual(
    calls.map(args => (args[0] === 'deploy' ? 'deploy' : args[2])),
    ['list', 'list', 'deploy'],
  );
  assert.equal(calls[0][3], 'DB');
  assert.ok(calls[0].includes('--remote'));
  assert.equal(calls[0].at(-1), calls.at(-1).at(-1));
});

test('pending migrations apply before verification and release', () => {
  const calls = [];
  deploy({
    run: args => {
      calls.push(args);
      return calls.length === 1 ? pending : none;
    },
  });
  assert.deepEqual(
    calls.map(args => (args[0] === 'deploy' ? 'deploy' : args[2])),
    ['list', 'apply', 'list', 'deploy'],
  );
  assert.deepEqual(calls[0].slice(3), calls[1].slice(3));
});

test('migration failure blocks release and frees the lock', () => {
  const calls = [];
  assert.throws(
    () =>
      deploy({
        run: args => {
          calls.push(args);
          if (args[2] === 'apply') throw new Error('migration failed');
          return pending;
        },
      }),
    /migration failed/,
  );
  assert.equal(calls.length, 2);
  deploy({ run: () => none });
});

test('historical pending migrations never apply or release', () => {
  const calls = [];
  assert.throws(
    () =>
      deploy({
        run: args => {
          calls.push(args);
          return 'Migrations to be applied:\n0004_ancient_triathlon.sql';
        },
      }),
    /Historical/,
  );
  assert.equal(calls.length, 1);
});

test('remaining pending migrations block release', () => {
  const calls = [];
  assert.throws(
    () =>
      deploy({
        run: args => {
          calls.push(args);
          return pending;
        },
      }),
    /remain pending/,
  );
  assert.equal(calls.length, 3);
});

test('published catalog migration is destructive and never auto-applies', () => {
  const calls = [];
  assert.throws(
    () =>
      productionDeploy({
        run: args => {
          calls.push(args);
          return pending;
        },
      }),
    /Destructive migration 0018_square_catalog.sql requires specific approval/,
  );
  assert.equal(calls.length, 1);
});

test('target overrides and concurrent deployment are rejected', () => {
  assert.throws(() => deploy({ args: ['--env', 'preview'] }), /overrides/);
  mkdirSync('.deploy-lock');
  try {
    assert.throws(
      () => deploy({ run: () => assert.fail('must not run') }),
      /EEXIST/,
    );
  } finally {
    rmdirSync('.deploy-lock');
  }
});

test('unrecognized output fails closed', () => {
  assert.throws(
    () =>
      pendingMigrations(`${pending}\nfoo.sql`, [
        '0018_square_catalog.sql',
        'foo.sql',
      ]),
    /Unknown/,
  );
  assert.throws(() => pendingMigrations('unknown', []), /Unrecognized/);
  assert.throws(
    () => pendingMigrations('Migrations to be applied: 0099_unknown.sql', []),
    /Unknown/,
  );
});
