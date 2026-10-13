import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BudgetLedger } from '../../src/shopping/budget';
import { BudgetCoordinator } from '../../src/shopping/budget-coordinator';
import { MemoryBudgetStorage } from '../shopping/storage';
import { expect, test, vi } from 'vitest';
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

/** Reconstruct business-rule objects from persisted mock state; no Worker runtime is used. */
test('ledger recovery retains accounting, outbox retries and replay across mocked runtime restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shopping-ledger-restart-'));
  const stateFile = join(root, 'mock-storage.json');
  const create = (accept: boolean) => {
    const storage = new MemoryBudgetStorage();
    let alarm: number | null = null;
    const restore = (saved: Snapshot) => {
      storage.reservations.clear();
      storage.alerts.clear();
      storage.starts.clear();
      for (const row of saved.reservations)
        storage.reservations.set(row.id, row as never);
      for (const row of saved.alerts)
        storage.alerts.set((row as unknown as { id: string }).id, row as never);
      for (const row of saved.starts)
        storage.starts.set((row as { id: string }).id, row as never);
      alarm = saved.alarm;
    };
    const snapshot = () =>
      structuredClone({
        reservations: [...storage.reservations.values()],
        alerts: [...storage.alerts.values()],
        starts: [...storage.starts.values()],
        alarm,
      });
    if (existsSync(stateFile))
      restore(JSON.parse(readFileSync(stateFile, 'utf8')));
    const transaction = <T>(work: () => T): T => {
      const before = snapshot();
      try {
        return work();
      } catch (error) {
        restore(before);
        throw error;
      }
    };
    const ledger = new BudgetLedger(storage);
    const coordinator = new BudgetCoordinator(
      ledger,
      storage,
      {
        exclusive: work => work(),
        transaction,
        getAlarm: async () => alarm,
        setAlarm: async at => {
          alarm = at;
        },
        deleteAlarm: async () => {
          alarm = null;
        },
      },
      {
        AGENT_BUDGET_FROM: 'budget@example.test',
        AGENT_BUDGET_TO: 'owner@example.test',
        BUDGET_EMAIL: {
          send: vi.fn(async () => {
            if (!accept) throw new Error('controlled_failure');
            return { messageId: 'controlled-ack' };
          }),
        },
      },
    );
    const ready = coordinator.resume();
    return {
      async call(operation: string, args: unknown[]) {
        await ready;
        const [first, second, third] = args;
        switch (operation) {
          case 'inspect':
            return snapshot();
          case 'admit':
            return transaction(() =>
              ledger.admit(first as string, second as string, third as string),
            );
          case 'reserve':
            return coordinator.reserve(
              first as Parameters<typeof coordinator.reserve>[0],
              second as string,
            );
          case 'settle':
            return coordinator.settle(
              first as string,
              second as Parameters<typeof coordinator.settle>[1],
            );
          case 'runAlarm':
            return coordinator.alarm();
          case 'historical':
            storage.updateReservation(first as string, { month: '2020-01' });
            return;
          case 'due':
            for (const alert of storage.alerts.values()) alert.nextAttempt = 0;
            return;
          case 'failReserve': {
            const original = storage.insertAlert.bind(storage);
            storage.insertAlert = row => {
              original(row);
              throw new Error('injected_after_alert');
            };
            try {
              return await coordinator.reserve(
                first as Parameters<typeof coordinator.reserve>[0],
                second as string,
              );
            } finally {
              storage.insertAlert = original;
            }
          }
          case 'failSettle': {
            const original = storage.updateReservation.bind(storage);
            storage.updateReservation = (id, row) => {
              original(id, row);
              throw new Error('injected_after_settlement');
            };
            try {
              return await coordinator.settle(first as string, {
                prompt_tokens: 10,
                completion_tokens: 2,
              });
            } finally {
              storage.updateReservation = original;
            }
          }
          default:
            throw new Error('Unknown mock command');
        }
      },
      async dispose() {
        await ready;
        writeFileSync(stateFile, JSON.stringify(snapshot()));
      },
    };
  };
  let worker = create(false);
  const call = (operation: string, ...args: unknown[]) =>
    worker.call(operation, args);
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
