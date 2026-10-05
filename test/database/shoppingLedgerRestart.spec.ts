import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { build } from 'vite';
import { expect, test } from 'vitest';
import { MONTHLY_CAP, PRICE, RESERVATION } from '../../src/shopping/pricing';

type Snapshot = {
  reservations: {
    id: string;
    charged: number;
    month: string;
    status: string;
  }[];
  alerts: { threshold: number; attempts: number; messageId: string | null }[];
  starts: unknown[];
  alarm: number | null;
};

/** Restart the entire workerd runtime over the same on-disk SQLite namespace. */
test('production SHOPPING_LEDGER retains accounting, outbox retries and replay across real SQLite restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shopping-ledger-restart-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'committed-sql-text',
        async load(id) {
          if (id.endsWith('.sql'))
            return `export default ${JSON.stringify(await readFile(id, 'utf8'))};`;
        },
      },
    ],
    build: {
      outDir: join(root, 'bundle'),
      lib: {
        entry: 'test/database/shoppingLedger.worker.ts',
        formats: ['es'],
        fileName: () => 'worker.js',
      },
      rollupOptions: { external: ['cloudflare:workers'] },
      minify: false,
    },
  });
  const create = (accept: boolean) =>
    new Miniflare({
      modules: true,
      modulesRoot: join(root, 'bundle'),
      scriptPath: join(root, 'bundle/worker.js'),
      compatibilityDate: '2026-04-01',
      durableObjects: {
        SHOPPING_LEDGER: { className: 'RestartLedger', useSQLite: true },
      },
      durableObjectsPersist: join(root, 'sqlite'),
      bindings: { ACCEPT_EMAIL: accept },
      outboundService: () => new Response('network forbidden', { status: 503 }),
    });
  let worker = create(false);
  const call = async (operation: string, ...args: unknown[]) => {
    const response = await worker.dispatchFetch('http://local.test', {
      method: 'POST',
      body: JSON.stringify({ operation, args }),
    });
    if (response.status !== 200) throw new Error(await response.text());
    return response.json();
  };
  const inspect = async () => (await call('inspect')) as Snapshot;
  try {
    for (let n = 0; n < 6; n++)
      expect(await call('admit', 'visitor', 'session', `run-${n}`)).toBe(true);
    const capacity = Math.floor(MONTHLY_CAP / RESERVATION);
    for (let n = 0; n < capacity; n++) {
      if (n === Math.ceil(MONTHLY_CAP / 2 / RESERVATION) - 1) {
        await expect(
          call(
            'failReserve',
            { sessionId: 'session', runId: 'rolled-back', invocation: 0 },
            PRICE.version,
          ),
        ).rejects.toThrow('injected_after_alert');
        expect((await inspect()).reservations).toHaveLength(n);
        expect((await inspect()).alerts).toEqual([]);
      }
      expect(
        await call(
          'reserve',
          { sessionId: 'session', runId: `budget-${n}`, invocation: 0 },
          PRICE.version,
        ),
      ).toMatchObject({ status: 'reserved' });
    }
    expect(
      await call(
        'reserve',
        { sessionId: 'session', runId: 'overflow', invocation: 0 },
        PRICE.version,
      ),
    ).toMatchObject({ status: 'exhausted' });
    await expect(call('failSettle', 'session/budget-0/0')).rejects.toThrow(
      'injected_after_settlement',
    );
    expect(
      (await inspect()).reservations.find(
        row => row.id === 'session/budget-0/0',
      ),
    ).toMatchObject({ charged: RESERVATION, status: 'reserved' });
    await call('settle', 'session/budget-0/0', null);
    await call('runAlarm');
    const before = await inspect();
    expect(before.reservations).toHaveLength(capacity);
    expect(before.reservations.reduce((sum, row) => sum + row.charged, 0)).toBe(
      capacity * RESERVATION,
    );
    expect(
      before.alerts.map(row => row.threshold).sort((a, b) => a - b),
    ).toEqual([50, 75, 100]);
    expect(
      before.alerts.every(row => row.attempts === 1 && row.messageId === null),
    ).toBe(true);
    expect(before.alarm).not.toBeNull();
    await worker.dispose();
    worker = create(true);
    const restarted = await inspect();
    expect(restarted.reservations).toEqual(before.reservations);
    expect(restarted.alerts).toEqual(before.alerts);
    expect(restarted.starts).toEqual(before.starts);
    expect(await call('admit', 'visitor', 'session', 'run-6')).toBe(false);
    expect(await call('admit', 'visitor', 'session', 'run-0')).toBe(true);
    expect(
      await call(
        'reserve',
        { sessionId: 'session', runId: 'budget-0', invocation: 0 },
        PRICE.version,
      ),
    ).toMatchObject({ status: 'duplicate' });
    expect(
      await call(
        'reserve',
        { sessionId: 'session', runId: 'still-overflow', invocation: 0 },
        PRICE.version,
      ),
    ).toMatchObject({ status: 'exhausted' });
    await call('historical', 'session/budget-0/0');
    expect(
      await call('settle', 'session/budget-0/0', {
        prompt_tokens: 10,
        completion_tokens: 2,
      }),
    ).toBe(2500);
    expect(
      await call('settle', 'session/budget-0/0', {
        prompt_tokens: 0,
        completion_tokens: 0,
      }),
    ).toBe(2500);
    expect(
      (await inspect()).reservations.find(
        row => row.id === 'session/budget-0/0',
      ),
    ).toMatchObject({ month: '2020-01', charged: 2500, status: 'settled' });
    await call('due');
    await call('runAlarm');
    const accepted = await inspect();
    expect(
      accepted.alerts.every(
        row => row.attempts === 2 && row.messageId === 'controlled-ack',
      ),
    ).toBe(true);
    expect(accepted.alarm).toBeNull();
    await worker.dispose();
    worker = create(true);
    expect((await inspect()).alerts).toEqual(accepted.alerts);
    await call('runAlarm');
    expect((await inspect()).alerts).toEqual(accepted.alerts);
  } finally {
    await worker.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
