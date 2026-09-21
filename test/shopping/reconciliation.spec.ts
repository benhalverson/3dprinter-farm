import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../../src/shopping/budget';
import { PRICE, RESERVATION, type Usage } from '../../src/shopping/pricing';
import { UsageReconciler } from '../../src/shopping/reconciliation';
import type { PendingUsage } from '../../src/shopping/storage/contracts';
import { MemoryBudgetStorage, MemoryUsageStorage } from './storage';

function fixture() {
  const storage = new MemoryUsageStorage();
  const budgetStorage = new MemoryBudgetStorage();
  const ledger = new BudgetLedger(budgetStorage);
  const reservation = ledger.reserve(
    {
      sessionId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      invocation: 0,
    },
    PRICE.version,
  );
  const tasks = new Map<string, PendingUsage>();
  const schedule = vi.fn(async (payload: PendingUsage) => {
    const id = JSON.stringify(payload);
    tasks.set(id, payload);
    return { id };
  });
  const cancel = vi.fn(async (id: string) => tasks.delete(id));
  const settle = vi.fn(async (id: string, usage: Usage) =>
    ledger.settle(id, usage),
  );
  const reconciler = () =>
    new UsageReconciler(storage, { schedule, cancel }, settle);
  return {
    storage,
    budgetStorage,
    ledger,
    reservation,
    tasks,
    schedule,
    cancel,
    settle,
    reconciler,
  };
}
afterEach(() => vi.useRealTimers());

describe('usage reconciliation with mocked persistence and SDK schedules', () => {
  it.each([
    'before',
    'after',
  ])('recovers a %s-settlement outage and concurrent retries exactly once in the original month', async failure => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-31T23:59:00Z'));
    const f = fixture();
    f.settle.mockImplementationOnce(async (id, usage) => {
      if (failure === 'after') f.ledger.settle(id, usage);
      throw new Error('private RPC failure');
    });
    await expect(
      f
        .reconciler()
        .record(f.reservation.id, {
          prompt_tokens: 100,
          completion_tokens: 100,
        }),
    ).rejects.toThrow();
    expect(f.storage.rows.size).toBe(1);
    expect(f.tasks.size).toBe(1);
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    const restarted = f.reconciler();
    await restarted.restore();
    expect(f.tasks.size).toBe(1);
    const [id, payload] = [...f.tasks][0];
    await Promise.all([
      restarted.reconcile(payload, id),
      restarted.reconcile(payload, id),
    ]);
    expect(f.storage.rows.size).toBe(0);
    expect(f.tasks.size).toBe(0);
    expect(f.budgetStorage.getReservation(f.reservation.id)).toMatchObject({
      month: '2026-01',
      charged: 65_000,
      status: 'settled',
    });
    expect(f.budgetStorage.totalCharged('2026-02')).toBe(0);
  });

  it('recovers a crash after SDK payload persistence but before the outbox write', async () => {
    const f = fixture();
    f.schedule.mockImplementationOnce(async payload => {
      f.tasks.set('persisted-before-crash', payload);
      throw new Error('interrupted');
    });
    await expect(
      f
        .reconciler()
        .record(f.reservation.id, { prompt_tokens: 1, completion_tokens: 1 }),
    ).rejects.toThrow();
    expect(f.storage.rows.size).toBe(0);
    expect(f.settle).not.toHaveBeenCalled();
    const [id, payload] = [...f.tasks][0];
    await f.reconciler().reconcile(payload, id);
    expect(f.budgetStorage.getReservation(f.reservation.id)?.charged).toBe(650);
    expect(f.tasks.size).toBe(0);
  });

  it('keeps another late result scheduled when a completed invocation cancels its task', async () => {
    const f = fixture();
    f.settle.mockRejectedValue(new Error('outage'));
    await expect(
      f
        .reconciler()
        .record(f.reservation.id, { prompt_tokens: 1, completion_tokens: 1 }),
    ).rejects.toThrow();
    const other = f.ledger.reserve(
      {
        sessionId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        invocation: 0,
      },
      PRICE.version,
    );
    await expect(
      f
        .reconciler()
        .record(other.id, { prompt_tokens: 2, completion_tokens: 2 }),
    ).rejects.toThrow();
    expect(f.tasks.size).toBe(2);
    f.settle.mockImplementation(async (id, usage) =>
      f.ledger.settle(id, usage),
    );
    const [id, payload] = [...f.tasks][0];
    await f.reconciler().reconcile(payload, id);
    expect(f.tasks.size).toBe(1);
    expect([...f.tasks.values()][0].id).toBe(other.id);
  });

  it('retains the reservation on invalid usage or unavailable task persistence', async () => {
    const f = fixture();
    await expect(
      f
        .reconciler()
        .record(f.reservation.id, { prompt_tokens: -1, completion_tokens: 0 }),
    ).rejects.toThrow();
    expect(f.schedule).not.toHaveBeenCalled();
    f.schedule.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(
      f
        .reconciler()
        .record(f.reservation.id, { prompt_tokens: 1, completion_tokens: 1 }),
    ).rejects.toThrow();
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.budgetStorage.getReservation(f.reservation.id)?.charged).toBe(
      RESERVATION,
    );
  });

  it('safely retries when acknowledgement is lost while cancelling a completed task', async () => {
    const f = fixture();
    f.cancel.mockRejectedValueOnce(new Error('cancel interrupted'));
    await expect(
      f
        .reconciler()
        .record(f.reservation.id, { prompt_tokens: 1, completion_tokens: 1 }),
    ).rejects.toThrow();
    const [id, payload] = [...f.tasks][0];
    await f.reconciler().reconcile(payload, id);
    expect(f.tasks.size).toBe(0);
    expect(f.budgetStorage.getReservation(f.reservation.id)?.charged).toBe(650);
  });
});
