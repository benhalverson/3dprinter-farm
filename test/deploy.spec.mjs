import assert from 'node:assert/strict';
import { mkdirSync, rmdirSync } from 'node:fs';
import { test } from 'node:test';
import { deploy, pendingMigrations } from '../tools/deploy.mjs';

const none = '? No migrations to apply!';
const pending = 'Migrations to be applied:\n� 0018_square_catalog.sql �';

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
