import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  deploy as productionDeploy,
  pendingMigrations,
  requiresMigrationApproval,
  hasSpecificMigrationApproval,
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

test('exact approved catalog migration applies before release', () => {
  const calls = [];
  productionDeploy({
    run: args => {
      calls.push(args);
      return calls.length === 1 ? pending : none;
    },
  });
  assert.deepEqual(
    calls.map(args => (args[0] === 'deploy' ? 'deploy' : args[2])),
    ['list', 'apply', 'list', 'deploy'],
  );
});

test('specific approval rejects changed contents and unrelated migrations', () => {
  const contents = readFileSync(
    'drizzle/migrations/0018_square_catalog.sql',
    'utf8',
  );
  assert.equal(
    hasSpecificMigrationApproval('0018_square_catalog.sql', contents),
    true,
  );
  assert.equal(
    hasSpecificMigrationApproval(
      '0018_square_catalog.sql',
      contents.replace(/\r?\n/g, '\r\n'),
    ),
    true,
  );
  assert.equal(hasSpecificMigrationApproval('0019_other.sql', contents), false);
  assert.equal(
    hasSpecificMigrationApproval('0018_square_catalog.sql', `${contents}\n`),
    false,
  );
  const calls = [];
  assert.throws(
    () =>
      productionDeploy({
        readMigration: () => `${contents}\n`,
        run: args => {
          calls.push(args);
          return pending;
        },
      }),
    /Destructive migration 0018_square_catalog.sql requires specific approval/,
  );
  assert.equal(calls.length, 1);
});

test('only the exact reviewed Square Stripe-removal migration receives destructive approval', () => {
  const name = '0022_square_order_storage.sql';
  const contents = readFileSync(`drizzle/migrations/${name}`, 'utf8');
  assert.equal(requiresMigrationApproval(contents), true);
  assert.equal(hasSpecificMigrationApproval(name, contents), true);
  assert.equal(
    hasSpecificMigrationApproval(name, contents.replace(/\r?\n/g, '\r\n')),
    true,
  );
  assert.equal(hasSpecificMigrationApproval('0023_other.sql', contents), false);
  assert.equal(hasSpecificMigrationApproval(name, `${contents}\n`), false);
  assert.equal(
    hasSpecificMigrationApproval(
      name,
      contents.replace('stripe_fulfillment', 'order_events'),
    ),
    false,
  );
  const additions = readFileSync(
    'drizzle/migrations/0021_square_online_checkout.sql',
    'utf8',
  );
  assert.equal(requiresMigrationApproval(additions), false);
  assert.equal(
    hasSpecificMigrationApproval('0021_square_online_checkout.sql', additions),
    false,
  );
});

test('reviewed Square removals apply before release but altered removals block all effects', () => {
  const name = '0022_square_order_storage.sql';
  const listing = `Migrations to be applied:\n${name}`;
  const calls = [];
  productionDeploy({
    run: args => {
      calls.push(args);
      return calls.length === 1 ? listing : none;
    },
  });
  assert.deepEqual(
    calls.map(args => (args[0] === 'deploy' ? 'deploy' : args[2])),
    ['list', 'apply', 'list', 'deploy'],
  );
  const rejected = [];
  assert.throws(
    () =>
      productionDeploy({
        readMigration: () =>
          `${readFileSync(`drizzle/migrations/${name}`, 'utf8')}\n`,
        run: args => {
          rejected.push(args);
          return listing;
        },
      }),
    /Destructive migration 0022_square_order_storage.sql requires specific approval/,
  );
  assert.equal(rejected.length, 1);
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

test('exact additive notification migration applies and verifies before simulated release', () => {
  const name = '0023_order_email_lifecycle.sql';
  const contents = readFileSync(`drizzle/migrations/${name}`, 'utf8');
  assert.equal(requiresMigrationApproval(contents), false);
  assert.equal(hasSpecificMigrationApproval(name, contents), false);
  const calls = [];
  productionDeploy({
    run: args => {
      calls.push(args);
      return calls.length === 1 ? `Migrations to be applied:\n${name}` : none;
    },
  });
  assert.deepEqual(
    calls.map(args => (args[0] === 'deploy' ? 'deploy' : args[2])),
    ['list', 'apply', 'list', 'deploy'],
  );
  assert.deepEqual(calls[0].slice(3), calls[1].slice(3));
});
