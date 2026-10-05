import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../../src/shopping/budget';
import { flushBudgetAlerts } from '../../src/shopping/budget-alerts';
import { sendBudgetEmail } from '../../src/shopping/budget-email';
import { MONTHLY_CAP, PRICE, RESERVATION } from '../../src/shopping/pricing';
import { MemoryBudgetStorage } from './storage';

/** Generate an independent paid invocation identity. */
const call = () => ({
  sessionId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  invocation: 0,
});
/** Seed an existing conservative liability using the real reservation shape. */
function seed(amount: number) {
  const storage = new MemoryBudgetStorage();
  const ledger = new BudgetLedger(storage);
  const { id } = ledger.reserve(call(), PRICE.version);
  storage.updateReservation(id, { charged: amount });
  return { storage, ledger, id };
}
/** A controlled sender never contacts a provider. */
function email() {
  return {
    AGENT_BUDGET_FROM: 'verified@example.test',
    AGENT_BUDGET_TO: 'owner@example.test',
    BUDGET_EMAIL: {
      send: vi.fn<SendEmail['send']>(async () => ({ messageId: 'accepted' })),
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('durable logical threshold alerts with mocked persistence', () => {
  it('records all thresholds on one update, keeps first crossing through refunds and reconstruction', async () => {
    const { storage, ledger, id } = seed(MONTHLY_CAP);
    ledger.settle(id, null);
    expect([...storage.alerts.values()].map(row => row.threshold)).toEqual([
      50, 75, 100,
    ]);
    const first = [...storage.alerts.values()];
    await Promise.all(
      Array.from({ length: 20 }, async () =>
        new BudgetLedger(storage).settle(id, null),
      ),
    );
    ledger.settle(id, { prompt_tokens: 1, completion_tokens: 1 });
    expect([...storage.alerts.values()]).toEqual(first);
    expect(storage.getReservation(id)?.charged).toBe(650);
  });

  it('reports exhausted admission capacity honestly even when residual budget is below the next reservation', async () => {
    const { storage, ledger } = seed(MONTHLY_CAP - RESERVATION + 1);
    expect(ledger.reserve(call(), PRICE.version).status).toBe('exhausted');
    const alert = [...storage.alerts.values()].find(
      row => row.threshold === 100,
    )!;
    expect(alert.exhausted).toBe(true);
    const env = email();
    await sendBudgetEmail(env, alert);
    const payload = env.BUDGET_EMAIL.send.mock.calls[0][0];
    expect(payload.subject).toContain('admission capacity exhausted');
    expect(payload.subject).not.toContain('100%');
    expect(payload.text).toContain('Accounted usage can be below USD 20.00');
    expect(payload.text).toContain('not a provider billing guarantee');
    expect(payload.headers['X-Lulu-Budget-Alert']).toBe(alert.id);
    for (const row of storage.alerts.values()) {
      if (row.threshold === 100) continue;
      expect(row.exhausted).toBe(false);
      await sendBudgetEmail(env, row);
      expect(env.BUDGET_EMAIL.send.mock.calls.at(-1)?.[0].subject).toContain(
        `${row.threshold}%`,
      );
    }
  });

  it('retains old-month liabilities and prices through missing, late and repeated reconciliation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-31T23:59:59.000Z'));
    const { storage, ledger, id } = seed(RESERVATION);
    storage.updateReservation(id, {
      priceVersion: 'original-price',
      inputRate: 100,
      outputRate: 200,
    });
    ledger.settle(id, null);
    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
    ledger.reserve(call(), PRICE.version);
    await Promise.all(
      Array.from({ length: 20 }, async () =>
        new BudgetLedger(storage).settle(id, {
          prompt_tokens: 10,
          completion_tokens: 2,
        }),
      ),
    );
    expect(storage.getReservation(id)).toMatchObject({
      month: '2026-01',
      charged: 1400,
      status: 'settled',
    });
    expect(storage.totalCharged('2026-02')).toBe(RESERVATION);
    expect(ledger.settle(id, null)).toBe(1400);
    expect(ledger.settle(id, { prompt_tokens: 0, completion_tokens: 0 })).toBe(
      1400,
    );
  });

  it('rejects invalid usage without releasing capacity', () => {
    const { storage, ledger, id } = seed(RESERVATION);
    storage.updateReservation(id, { inputRate: Number.MAX_SAFE_INTEGER });
    expect(() =>
      ledger.settle(id, { prompt_tokens: 2, completion_tokens: 0 }),
    ).toThrow('invalid_usage');
    expect(() =>
      ledger.settle(id, { prompt_tokens: -1, completion_tokens: 0 }),
    ).toThrow();
    expect(() => ledger.settle('missing', null)).toThrow('unknown_reservation');
    expect(storage.getReservation(id)?.charged).toBe(RESERVATION);
  });

  it('allows distinct thresholds in a new UTC month without deleting prior delivery state', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-31T23:59:59Z'));
    const { storage, ledger, id } = seed(MONTHLY_CAP);
    ledger.settle(id, null);
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    const next = ledger.reserve(call(), PRICE.version);
    storage.updateReservation(next.id, { charged: MONTHLY_CAP });
    ledger.settle(next.id, null);
    expect(storage.alerts.size).toBe(6);
    expect(storage.reservations.size).toBe(2);
  });

  it('retries delivery failures with pinned addresses, no duplicate logical alerts and no spend reset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { storage, ledger, id } = seed(MONTHLY_CAP);
    ledger.settle(id, null);
    const env = email();
    env.BUDGET_EMAIL.send.mockRejectedValue(
      new Error('private credentials owner@example.test'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await flushBudgetAlerts(storage, env);
    expect(env.BUDGET_EMAIL.send).toHaveBeenCalledTimes(3);
    expect(storage.totalCharged(new Date().toISOString().slice(0, 7))).toBe(
      MONTHLY_CAP,
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /private|credentials|owner@example/,
    );
    await flushBudgetAlerts(storage, env);
    expect(env.BUDGET_EMAIL.send).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + 60_000);
    env.BUDGET_EMAIL.send.mockResolvedValue({ messageId: 'delivered' });
    env.AGENT_BUDGET_TO = 'changed@example.test';
    await flushBudgetAlerts(storage, env);
    expect(storage.alerts.size).toBe(3);
    expect(
      [...storage.alerts.values()].every(row => row.messageId === 'delivered'),
    ).toBe(true);
    expect(env.BUDGET_EMAIL.send.mock.calls.at(-1)?.[0].to).toBe(
      'owner@example.test',
    );
    await flushBudgetAlerts(storage, env);
    expect(env.BUDGET_EMAIL.send).toHaveBeenCalledTimes(6);
  });

  it('claims concurrent deliveries once, survives crash after send and ignores stale acknowledgements', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { storage, ledger, id } = seed(10_000_000_000);
    ledger.settle(id, null);
    const env = email();
    const accept = vi.spyOn(storage, 'accept').mockImplementationOnce(() => {
      throw new Error('crash after send');
    });
    await Promise.all([
      flushBudgetAlerts(storage, env),
      flushBudgetAlerts(storage, env),
    ]);
    expect(env.BUDGET_EMAIL.send).toHaveBeenCalledTimes(1);
    const first = [...storage.alerts.values()][0];
    vi.setSystemTime(Date.now() + 60_000);
    const second = storage.claim(Date.now(), null, null)!;
    storage.accept(first.id, first.lease!, 'stale');
    expect(storage.alerts.get(first.id)?.messageId).toBeNull();
    storage.accept(second.id, second.lease!, 'recovered');
    expect(storage.alerts.size).toBe(1);
    expect(storage.alerts.get(first.id)?.messageId).toBe('recovered');
    expect(accept).toHaveBeenCalledTimes(3);
  });

  it('retains unconfigured and unacknowledged deliveries for retry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { storage, ledger, id } = seed(10_000_000_000);
    ledger.settle(id, null);
    await flushBudgetAlerts(storage, {});
    expect([...storage.alerts.values()][0]).toMatchObject({
      attempts: 1,
      sender: null,
      recipient: null,
      messageId: null,
    });
    vi.setSystemTime(Date.now() + 60_000);
    const env = email();
    env.BUDGET_EMAIL.send.mockResolvedValue({ messageId: '' });
    await flushBudgetAlerts(storage, env);
    expect([...storage.alerts.values()][0]).toMatchObject({
      attempts: 2,
      messageId: null,
    });
    await expect(
      sendBudgetEmail(
        { ...env, BUDGET_EMAIL: undefined },
        [...storage.alerts.values()][0],
      ),
    ).rejects.toThrow('budget_email_unconfigured');
  });

  it('bounds stalled sends and retries the same logical identity after its durable backoff', async () => {
    vi.useFakeTimers();
    const { storage, ledger, id } = seed(10_000_000_000);
    ledger.settle(id, null);
    const env = email();
    env.BUDGET_EMAIL.send.mockImplementation(() => new Promise(() => {}));
    const pending = flushBudgetAlerts(storage, env);
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(storage.alerts.size).toBe(1);
    expect([...storage.alerts.values()][0].messageId).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
