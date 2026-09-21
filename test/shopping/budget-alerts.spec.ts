import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../../src/shopping/budget';
import { flushBudgetAlerts } from '../../src/shopping/budget-alerts';
import { PRICE, RESERVATION } from '../../src/shopping/pricing';
import { MemoryBudgetStorage } from './storage';

const correlation = () => ({
  sessionId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  invocation: 0,
});
const config = {
  AGENT_BUDGET_FROM: 'budget@example.test',
  AGENT_BUDGET_TO: 'owner@example.test',
};
const wake = () => vi.fn<(at: number) => Promise<void>>().mockResolvedValue();
function fixture(count = 51) {
  const storage = new MemoryBudgetStorage();
  const ledger = new BudgetLedger(storage);
  for (let n = 0; n < count; n++) ledger.reserve(correlation(), PRICE.version);
  const send = vi
    .fn<SendEmail['send']>()
    .mockResolvedValue({ messageId: 'accepted' });
  return { storage, ledger, send, env: { ...config, BUDGET_EMAIL: { send } } };
}
afterEach(() => vi.useRealTimers());

describe('budget alerts with mocked storage, alarm and email boundaries', () => {
  it('deduplicates threshold crossings and concurrent delivery attempts', async () => {
    const { storage, ledger, send, env } = fixture(100);
    await Promise.all(
      Array.from({ length: 10 }, async () =>
        ledger.reserve(correlation(), PRICE.version),
      ),
    );
    expect([...storage.alerts.values()].map(row => row.threshold)).toEqual([
      50, 75, 100,
    ]);
    await Promise.all([
      flushBudgetAlerts(storage, env, wake()),
      flushBudgetAlerts(storage, env, wake()),
    ]);
    expect(send).toHaveBeenCalledTimes(3);
    await flushBudgetAlerts(storage, env, wake());
    expect(send).toHaveBeenCalledTimes(3);
    expect([...storage.alerts.values()].every(row => row.messageId)).toBe(true);
  });

  it('queues all thresholds crossed by one update and retains them after late settlement', () => {
    const { storage, ledger } = fixture(1);
    const record = [...storage.reservations.values()][0];
    storage.updateReservation(record.id, { charged: 19_900_000_000 });
    expect(ledger.reserve(correlation(), PRICE.version).status).toBe(
      'exhausted',
    );
    expect(storage.alerts.size).toBe(3);
    ledger.settle(record.id, { prompt_tokens: 1, completion_tokens: 1 });
    expect(ledger.reserve(correlation(), PRICE.version).status).toBe(
      'reserved',
    );
    expect(storage.alerts.size).toBe(3);
  });

  it('retries failures with backoff, preserving spend and the original recipient', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { storage, send, env } = fixture();
    const alarm = wake();
    send.mockRejectedValueOnce(new Error('private-provider-error'));
    await flushBudgetAlerts(storage, env, alarm);
    expect(alarm).toHaveBeenCalled();
    expect([...storage.alerts.values()][0]).toMatchObject({
      attempts: 1,
      messageId: null,
      recipient: config.AGENT_BUDGET_TO,
    });
    await flushBudgetAlerts(storage, env, alarm);
    expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 60_000);
    await flushBudgetAlerts(
      storage,
      { ...env, AGENT_BUDGET_TO: 'changed@example.test' },
      alarm,
    );
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: config.AGENT_BUDGET_TO }),
    );
    expect(storage.alerts.size).toBe(1);
    expect([...storage.alerts.values()][0]).toMatchObject({
      attempts: 2,
      messageId: 'accepted',
    });
    expect(storage.totalCharged(new Date().toISOString().slice(0, 7))).toBe(
      51 * RESERVATION,
    );
  });

  it('recovers an abandoned claim and rejects a stale acknowledgement', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { storage, env, send } = fixture();
    const abandoned = storage.claim(
      Date.now(),
      config.AGENT_BUDGET_FROM,
      config.AGENT_BUDGET_TO,
    );
    if (!abandoned?.lease) throw new Error('Missing claim');
    await flushBudgetAlerts(storage, env, wake());
    expect(send).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 60_000);
    await flushBudgetAlerts(storage, env, wake());
    storage.accept(abandoned.id, abandoned.lease, 'stale-ack');
    expect(storage.alerts.get(abandoned.id)?.messageId).toBe('accepted');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retains alerts when configuration or durable wake-up is unavailable', async () => {
    const { storage, send, env } = fixture();
    const alarm = wake().mockRejectedValueOnce(new Error('alarm unavailable'));
    await expect(flushBudgetAlerts(storage, env, alarm)).rejects.toThrow(
      'alarm unavailable',
    );
    expect(send).not.toHaveBeenCalled();
    await flushBudgetAlerts(storage, {}, wake());
    expect([...storage.alerts.values()][0]).toMatchObject({
      attempts: 1,
      messageId: null,
      recipient: null,
    });
  });

  it('deduplicates each month independently while late usage stays in the original month', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-31T23:59:00Z'));
    const { storage, ledger } = fixture();
    const first = [...storage.reservations.values()][0];
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    const restarted = new BudgetLedger(storage);
    for (let n = 0; n < 51; n++)
      restarted.reserve(correlation(), PRICE.version);
    ledger.settle(first.id, { prompt_tokens: 1, completion_tokens: 1 });
    expect([...storage.alerts.values()].map(row => row.month)).toEqual([
      '2026-01',
      '2026-02',
    ]);
    expect(storage.totalCharged('2026-01')).toBe(50 * RESERVATION + 650);
    expect(storage.totalCharged('2026-02')).toBe(51 * RESERVATION);
  });
});
