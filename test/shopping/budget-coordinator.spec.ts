import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../../src/shopping/budget';
import {
  BudgetCoordinator,
  type BudgetRuntime,
} from '../../src/shopping/budget-coordinator';
import { MONTHLY_CAP, PRICE, RESERVATION } from '../../src/shopping/pricing';
import { MemoryBudgetStorage } from './storage';

/** Independently identify an invocation so concurrent admission tests cannot deduplicate it. */
const call = () => ({
  sessionId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  invocation: 0,
});
/** Model the exclusive runtime gate while leaving persistence explicitly mocked. */
function fixture() {
  const storage = new MemoryBudgetStorage();
  const ledger = new BudgetLedger(storage);
  let scheduled: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const runtime: BudgetRuntime = {
    exclusive<T>(work: () => Promise<T>) {
      const next = tail.then(work);
      tail = next.catch(() => {});
      return next;
    },
    transaction: vi.fn(work => work()),
    getAlarm: vi.fn(async () => scheduled),
    setAlarm: vi.fn(async at => {
      scheduled = at;
    }),
    deleteAlarm: vi.fn(async () => {
      scheduled = null;
    }),
  };
  const env = {
    AGENT_BUDGET_FROM: 'sender@example.test',
    AGENT_BUDGET_TO: 'owner@example.test',
    BUDGET_EMAIL: { send: vi.fn(async () => ({ messageId: 'accepted' })) },
  };
  return {
    storage,
    ledger,
    runtime,
    env,
    coordinator: new BudgetCoordinator(ledger, storage, runtime, env),
  };
}
afterEach(() => vi.useRealTimers());

describe('ledger scheduling with controlled runtime dependencies', () => {
  it('serializes concurrent admission and preserves the hard ceiling with missing usage', async () => {
    const { coordinator, storage } = fixture();
    const results = await Promise.all(
      Array.from({ length: 110 }, () =>
        coordinator.reserve(call(), PRICE.version),
      ),
    );
    const accepted = results.filter(row => row.status === 'reserved');
    expect(accepted).toHaveLength(Math.floor(MONTHLY_CAP / RESERVATION));
    expect(storage.totalCharged(new Date().toISOString().slice(0, 7))).toBe(
      accepted.length * RESERVATION,
    );
    expect(storage.alerts.size).toBe(3);
    await Promise.all(accepted.map(row => coordinator.settle(row.id, null)));
    expect((await coordinator.reserve(call(), PRICE.version)).status).toBe(
      'exhausted',
    );
  });

  it('fails closed before reservation if durable wakeup cannot be written', async () => {
    const { coordinator, storage, runtime } = fixture();
    vi.mocked(runtime.setAlarm).mockRejectedValue(
      new Error('storage unavailable'),
    );
    await expect(coordinator.reserve(call(), PRICE.version)).rejects.toThrow();
    expect(storage.reservations.size).toBe(0);
    expect(runtime.transaction).not.toHaveBeenCalled();
  });

  it('pre-arms crash recovery, then clears the alarm only after successful delivery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { coordinator, storage, runtime, env } = fixture();
    const first = await coordinator.reserve(call(), PRICE.version);
    storage.updateReservation(first.id, { charged: MONTHLY_CAP });
    await coordinator.settle(first.id, null);
    expect(
      vi.mocked(runtime.setAlarm).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(runtime.transaction).mock.invocationCallOrder[0]);
    await coordinator.alarm();
    expect(env.BUDGET_EMAIL.send).toHaveBeenCalledTimes(3);
    expect(runtime.deleteAlarm).toHaveBeenCalledOnce();
    expect(storage.nextAttempt()).toBeUndefined();
  });

  it('recovers pending retry deadlines on activation and does not move an earlier alarm', async () => {
    const { coordinator, storage, runtime } = fixture();
    await coordinator.resume();
    expect(runtime.setAlarm).not.toHaveBeenCalled();
    const first = await coordinator.reserve(call(), PRICE.version);
    storage.updateReservation(first.id, { charged: MONTHLY_CAP });
    await coordinator.settle(first.id, null);
    await runtime.deleteAlarm();
    await coordinator.resume();
    expect(await runtime.getAlarm()).not.toBeNull();
    const count = vi.mocked(runtime.setAlarm).mock.calls.length;
    await coordinator.resume();
    expect(runtime.setAlarm).toHaveBeenCalledTimes(count);
  });

  it('keeps the recovery wakeup after a claim failure and schedules provider backoff after a send failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { coordinator, storage, runtime, env } = fixture();
    const first = await coordinator.reserve(call(), PRICE.version);
    storage.updateReservation(first.id, { charged: MONTHLY_CAP });
    await coordinator.settle(first.id, null);
    vi.spyOn(storage, 'claim').mockImplementationOnce(() => {
      throw new Error('outage');
    });
    await expect(coordinator.alarm()).rejects.toThrow('outage');
    expect(await runtime.getAlarm()).toBe(Date.now() + 60_000);
    env.BUDGET_EMAIL.send.mockRejectedValue(new Error('provider down'));
    await coordinator.alarm();
    expect(await runtime.getAlarm()).toBe(storage.nextAttempt());
    expect(runtime.deleteAlarm).not.toHaveBeenCalled();
    expect(storage.reservations.get(first.id)?.charged).toBe(MONTHLY_CAP);
  });

  it('admits and queues thresholds while a delivery is pending without losing the next wakeup', async () => {
    const { coordinator, storage, env, runtime } = fixture();
    const first = await coordinator.reserve(call(), PRICE.version);
    storage.updateReservation(first.id, { charged: 10_000_000_000 });
    await coordinator.settle(first.id, null);
    let finish!: (value: { messageId: string }) => void;
    env.BUDGET_EMAIL.send.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const alarm = coordinator.alarm();
    await vi.waitFor(() =>
      expect(env.BUDGET_EMAIL.send).toHaveBeenCalledOnce(),
    );
    const next = await coordinator.reserve(call(), PRICE.version);
    storage.updateReservation(next.id, { charged: 5_000_000_000 });
    await coordinator.settle(next.id, null);
    env.BUDGET_EMAIL.send.mockRejectedValue(new Error('later provider outage'));
    finish({ messageId: 'first' });
    await alarm;
    expect(storage.alerts.size).toBe(2);
    expect(await runtime.getAlarm()).toBe(storage.nextAttempt());
    expect(runtime.deleteAlarm).not.toHaveBeenCalled();
  });
});
