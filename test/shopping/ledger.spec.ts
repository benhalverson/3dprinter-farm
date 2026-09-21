import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../../src/shopping/budget';
import { MONTHLY_CAP, PRICE, RESERVATION } from '../../src/shopping/pricing';
import { MemoryBudgetStorage } from './storage';

const ledger = (storage = new MemoryBudgetStorage()) =>
  new BudgetLedger(storage);
afterEach(() => vi.useRealTimers());
const correlation = () => ({
  sessionId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  invocation: 0,
});

describe('budget rules with mocked persistence', () => {
  it('admits reservations only within the monthly cap', async () => {
    const stub = ledger();
    const results = await Promise.all(
      Array.from({ length: 110 }, () =>
        stub.reserve(correlation(), PRICE.version),
      ),
    );
    const accepted = results.filter(result => result.status === 'reserved');
    expect(accepted.length).toBe(Math.floor(MONTHLY_CAP / RESERVATION));
    expect(accepted.length * RESERVATION).toBeLessThanOrEqual(MONTHLY_CAP);
    expect(results.some(result => result.status === 'exhausted')).toBe(true);
  });

  it('settles once and never reauthorizes a duplicate invocation', async () => {
    const stub = ledger();
    const call = correlation();
    const reserved = await stub.reserve(call, PRICE.version);
    expect(await stub.reserve(call, PRICE.version)).toEqual({
      status: 'duplicate',
      id: reserved.id,
    });
    expect(
      await stub.settle(reserved.id, {
        prompt_tokens: 100,
        completion_tokens: 20,
      }),
    ).toBe(25_000);
    expect(
      await stub.settle(reserved.id, {
        prompt_tokens: 500,
        completion_tokens: 40,
      }),
    ).toBe(25_000);
    expect(() =>
      stub.settle(reserved.id, { prompt_tokens: -1, completion_tokens: 0 }),
    ).toThrow();
  });

  it('keeps missing usage reserved through month rollover; late usage changes the original bucket', async () => {
    const storage = new MemoryBudgetStorage();
    const stub = ledger(storage);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2000-01-31T23:59:00Z'));
    const call = correlation();
    const reservation = stub.reserve(call, PRICE.version);
    vi.setSystemTime(new Date('2000-02-01T00:00:00Z'));
    expect(ledger(storage).reserve(call, PRICE.version).status).toBe(
      'duplicate',
    );
    expect(storage.getReservation(reservation.id)?.charged).toBe(RESERVATION);
    expect(stub.reserve(correlation(), PRICE.version).status).toBe('reserved');
    stub.settle(reservation.id, { prompt_tokens: 1, completion_tokens: 1 });
    expect(storage.getReservation(reservation.id)).toMatchObject({
      month: '2000-01',
      status: 'settled',
      charged: 650,
    });
    expect(storage.totalCharged('2000-02')).toBe(RESERVATION);
  });

  it('enforces six per minute across new sessions and sixty per rolling day', async () => {
    const stub = ledger();
    vi.useFakeTimers({ toFake: ['Date'] });
    const calls = await Promise.all(
      Array.from({ length: 10 }, () =>
        stub.admit('visitor', crypto.randomUUID(), crypto.randomUUID()),
      ),
    );
    expect(calls.filter(Boolean)).toHaveLength(6);
    for (let batch = 1; batch < 10; batch++) {
      vi.setSystemTime(Date.now() + 61_000);
      for (let n = 0; n < 6; n++)
        expect(
          await stub.admit('visitor', crypto.randomUUID(), crypto.randomUUID()),
        ).toBe(true);
    }
    vi.setSystemTime(Date.now() + 61_000);
    expect(
      await stub.admit('visitor', crypto.randomUUID(), crypto.randomUUID()),
    ).toBe(false);
    expect(
      await stub.admit(
        'another-visitor',
        crypto.randomUUID(),
        crypto.randomUUID(),
      ),
    ).toBe(true);
  });

  it('fails closed on unrecognized prices', async () => {
    expect(() => ledger().reserve(correlation(), 'unknown')).toThrow(
      'pricing_unavailable',
    );
  });
});
