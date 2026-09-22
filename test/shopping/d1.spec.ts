import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { D1Accounting } from '../../src/shopping/accounting';
import { flushBudgetAlerts } from '../../src/shopping/budget-alerts';
import { runInference } from '../../src/shopping/inference';
import { MONTHLY_CAP, PRICE, RESERVATION } from '../../src/shopping/pricing';
import { UsageReconciler } from '../../src/shopping/reconciliation';
import {
  alertStorage,
  sessionStorage,
  usageStorage,
} from '../../src/shopping/storage/d1';
import {
  accountingRevisions,
  budgetAlerts,
  reservations,
  starts,
} from '../../src/shopping/storage/ledger-schema';
import {
  pendingUsage,
  runs,
  visits,
} from '../../src/shopping/storage/visit-schema';
import { catalog, completion } from './fixtures';

let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let db: ReturnType<typeof drizzle>;
let accounting: D1Accounting;
const migrationsFolder = mkdtempSync(join(tmpdir(), 'shopping-d1-'));
const correlation = () => ({
  sessionId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  invocation: 0,
});

function withBatch(batch: D1Database['batch']) {
  return new Proxy(platform.env.DB, {
    get(target, key) {
      if (key === 'batch') return batch;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  // Existing commerce migration history contains overlapping ALTERs. Generate a
  // disposable baseline from the canonical schema, using Kit and the native migrator.
  execFileSync(
    'pnpm',
    [
      'exec',
      'drizzle-kit',
      'generate',
      '--dialect=sqlite',
      '--schema=./src/db/schema.ts',
      `--out=${migrationsFolder}`,
    ],
    { stdio: 'pipe' },
  );
  platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath: 'test/shopping/wrangler.toml',
    persist: false,
  });
  db = drizzle(platform.env.DB);
  await migrate(db, { migrationsFolder });
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.batch([
    db.delete(accountingRevisions),
    db.delete(budgetAlerts),
    db.delete(reservations),
    db.delete(starts),
    db.delete(pendingUsage),
    db.delete(runs),
    db.delete(visits),
  ]);
  accounting = new D1Accounting(platform.env.DB);
});
afterAll(async () => {
  await platform?.dispose();
  rmSync(migrationsFolder, { recursive: true, force: true });
});

async function seedCharged(charged: number) {
  const first = await accounting.reserve(correlation(), PRICE.version);
  await db
    .update(reservations)
    .set({ charged })
    .where(eq(reservations.id, first.id));
  return first;
}

describe('accounting on local D1 with real Drizzle batches', () => {
  it('serializes competing reservations at the cap and atomically creates each alert', async () => {
    await seedCharged(MONTHLY_CAP - RESERVATION);
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        new D1Accounting(platform.env.DB).reserve(correlation(), PRICE.version),
      ),
    );
    expect(outcomes.filter(row => row.status === 'reserved')).toHaveLength(1);
    expect(outcomes.filter(row => row.status === 'exhausted')).toHaveLength(4);
    const records = await db.select().from(reservations);
    expect(records.reduce((sum, row) => sum + row.charged, 0)).toBe(
      MONTHLY_CAP,
    );
    expect(
      (await db.select().from(budgetAlerts)).map(row => row.threshold).sort(),
    ).toEqual([100, 50, 75]);
  });

  it('deduplicates concurrent admission, reservation and settlement', async () => {
    const call = correlation();
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          accounting.admit('visitor', call.sessionId, call.runId),
        ),
      ),
    ).toEqual([true, true, true, true]);
    expect(await db.select().from(starts)).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => accounting.reserve(call, PRICE.version)),
    );
    expect(results.filter(row => row.status === 'reserved')).toHaveLength(1);
    const costs = await Promise.all(
      [1, 2, 3, 4].map(count =>
        accounting.settle(results[0].id, {
          prompt_tokens: count,
          completion_tokens: count,
        }),
      ),
    );
    expect(new Set(costs).size).toBe(1);
    expect(await db.select().from(reservations)).toHaveLength(1);
  });

  it('serializes admissions across sessions near the minute allowance', async () => {
    for (let n = 0; n < 5; n++)
      await accounting.admit('visitor', `session-${n}`, 'run');
    const admitted = await Promise.all(
      Array.from({ length: 5 }, (_, n) =>
        accounting.admit('visitor', `new-${n}`, 'run'),
      ),
    );
    expect(admitted.filter(Boolean)).toHaveLength(1);
  });

  it('rolls back reservation and alerts together when any batch statement fails', async () => {
    await seedCharged(MONTHLY_CAP / 2 - RESERVATION);
    const existing = await db.select().from(reservations).get();
    if (!existing) throw new Error('Missing reservation');
    const duplicate = db.insert(reservations).values(existing).toSQL();
    const batch = platform.env.DB.batch.bind(platform.env.DB);
    accounting = new D1Accounting(
      withBatch(statements =>
        batch([
          ...statements,
          // A Drizzle-generated duplicate fails after all staged mutations.
          platform.env.DB.prepare(duplicate.sql).bind(...duplicate.params),
        ]),
      ),
    );
    await expect(
      accounting.reserve(correlation(), PRICE.version),
    ).rejects.toThrow();
    expect(await db.select().from(reservations)).toHaveLength(1);
    expect(await db.select().from(budgetAlerts)).toHaveLength(0);
  });

  it('fails closed on D1 outages and bounded revision conflicts', async () => {
    const batch = vi
      .fn<D1Database['batch']>()
      .mockRejectedValue(new Error('D1 unavailable'));
    accounting = new D1Accounting(withBatch(batch));
    await expect(
      accounting.reserve(correlation(), PRICE.version),
    ).rejects.toThrow();
    expect(batch).toHaveBeenCalledTimes(1);
    batch
      .mockClear()
      .mockRejectedValue(
        new Error(
          'UNIQUE constraint failed: shopping_accounting_revisions.revision',
        ),
      );
    await expect(
      accounting.reserve(correlation(), PRICE.version),
    ).rejects.toThrow('accounting_unavailable');
    expect(batch).toHaveBeenCalledTimes(6);
    const infer = vi.fn(async () => completion());
    await expect(
      runInference(
        {
          runId: crypto.randomUUID(),
          uiRevision: 1,
          message: 'Show tools',
          context: [],
        },
        'session',
        {
          accounting,
          infer,
          read: async () => catalog,
          active: () => true,
          signal: new AbortController().signal,
          progress: () => {},
        },
      ),
    ).rejects.toMatchObject({ reason: 'accounting_unavailable' });
    expect(infer).not.toHaveBeenCalled();
    expect(await db.select().from(reservations)).toHaveLength(0);
    expect(await db.select().from(budgetAlerts)).toHaveLength(0);
  });

  it('claims email leases conditionally and rejects stale acknowledgements', async () => {
    await seedCharged(MONTHLY_CAP / 2 - RESERVATION);
    await accounting.reserve(correlation(), PRICE.version);
    const alerts = alertStorage(platform.env.DB);
    const now = Date.now();
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        alerts.claim(now, 'from@example.test', 'to@example.test'),
      ),
    );
    const claimed = claims.filter(row => row !== undefined);
    expect(claimed).toHaveLength(1);
    const first = claimed[0];
    const second = await alerts.claim(
      now + 60_000,
      'other@example.test',
      'other@example.test',
    );
    expect(second?.recipient).toBe('to@example.test');
    if (!first.lease || !second?.lease) throw new Error('Missing lease');
    await alerts.accept(first.id, first.lease, 'stale');
    expect((await db.select().from(budgetAlerts).get())?.messageId).toBeNull();
    await alerts.accept(second.id, second.lease, 'accepted');
    expect((await db.select().from(budgetAlerts).get())?.messageId).toBe(
      'accepted',
    );
  });

  it('competing cron deliveries send only claimed alerts and retry failed sends', async () => {
    await seedCharged(MONTHLY_CAP / 2 - RESERVATION);
    await accounting.reserve(correlation(), PRICE.version);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('email unavailable'))
      .mockResolvedValue({ messageId: 'accepted' });
    const env = {
      BUDGET_EMAIL: { send },
      AGENT_BUDGET_FROM: 'from@example.test',
      AGENT_BUDGET_TO: 'to@example.test',
    };
    await Promise.all([
      flushBudgetAlerts(alertStorage(platform.env.DB), env),
      flushBudgetAlerts(alertStorage(platform.env.DB), env),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    await db.update(budgetAlerts).set({ nextAttempt: 0 });
    await flushBudgetAlerts(alertStorage(platform.env.DB), env);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await db.select().from(budgetAlerts).get())?.messageId).toBe(
      'accepted',
    );
  });
});

describe('D1 session and usage isolation', () => {
  it('isolates identical run and pending-usage IDs across sessions and restarts', async () => {
    const a = sessionStorage(platform.env.DB, 'a');
    const b = sessionStorage(platform.env.DB, 'b');
    for (const [id, storage] of [
      ['a', a],
      ['b', b],
    ] as const) {
      await storage.insertVisit({
        id,
        capability: id,
        visitor: id,
        created: 1,
        touched: 1,
      });
      await storage.insertRun({
        id: 'same',
        revision: 1,
        status: 'running',
        reason: null,
      });
      await usageStorage(platform.env.DB, id).insertUsage({
        id: 'same',
        inputTokens: 1,
        outputTokens: 2,
      });
    }
    await a.interruptRuns();
    await a.updateVisit('b', { capability: 'wrong' });
    await usageStorage(platform.env.DB, 'a').deleteUsage('same');
    expect(
      (await sessionStorage(platform.env.DB, 'a').getRun('same'))?.reason,
    ).toBe('interrupted');
    expect((await b.getRun('same'))?.status).toBe('running');
    expect((await b.getVisit())?.capability).toBe('b');
    expect(await usageStorage(platform.env.DB, 'a').listUsage()).toHaveLength(
      0,
    );
    expect(await usageStorage(platform.env.DB, 'b').listUsage()).toHaveLength(
      1,
    );
    expect(
      await a.insertRun({
        id: 'same',
        revision: 2,
        status: 'running',
        reason: null,
      }),
    ).toBe(false);
    await a.updateRun('same', { status: 'completed', reason: null });
    expect((await a.getRun('same'))?.reason).toBe('interrupted');
  });

  it('recovers persisted usage after a settlement outage without another inference', async () => {
    const call = correlation();
    const reserved = await accounting.reserve(call, PRICE.version);
    const tasks = {
      schedule: vi.fn(async () => ({ id: 'task' })),
      cancel: vi.fn(async () => true),
    };
    const first = new UsageReconciler(
      usageStorage(platform.env.DB, call.sessionId),
      tasks,
      async () => {
        throw new Error('D1 outage');
      },
    );
    await expect(
      first.record(reserved.id, { prompt_tokens: 1, completion_tokens: 1 }),
    ).rejects.toThrow('D1 outage');
    const restarted = new UsageReconciler(
      usageStorage(platform.env.DB, call.sessionId),
      tasks,
      (id, usage) => accounting.settle(id, usage),
    );
    await restarted.restore();
    const payload = (
      await usageStorage(platform.env.DB, call.sessionId).listUsage()
    )[0];
    expect(payload).toEqual({
      id: reserved.id,
      inputTokens: 1,
      outputTokens: 1,
    });
    await Promise.all([
      restarted.reconcile(payload, 'task'),
      restarted.reconcile(payload, 'task'),
    ]);
    expect((await db.select().from(reservations).get())?.charged).toBe(650);
    expect(
      await usageStorage(platform.env.DB, call.sessionId).listUsage(),
    ).toEqual([]);
  });
});
