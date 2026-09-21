import { env, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';
import { ShoppingLedger } from '../../src/shopping/ledger';
import { MONTHLY_CAP, PRICE, RESERVATION } from '../../src/shopping/pricing';
import { reservations, starts } from '../../src/shopping/storage/ledger-schema';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Cloudflare.Env {}
}
const ledger = () =>
  env.SHOPPING_LEDGER.get(env.SHOPPING_LEDGER.idFromName(crypto.randomUUID()));
const correlation = () => ({
  sessionId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  invocation: 0,
});

describe('SQLite budget ledger through Drizzle', () => {
  it('admits simultaneous reservations only within the monthly cap', async () => {
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
    await expect(
      stub.settle(reserved.id, { prompt_tokens: -1, completion_tokens: 0 }),
    ).rejects.toThrow();
  });

  it('keeps missing usage reserved across reconstruction and month rollover; late usage changes the original bucket', async () => {
    const stub = ledger();
    const call = correlation();
    const reservation = await stub.reserve(call, PRICE.version);
    await runInDurableObject(stub, async (_instance, ctx) => {
      const db = drizzle(ctx.storage);
      db.update(reservations)
        .set({ month: '2000-01' })
        .where(eq(reservations.id, reservation.id))
        .run();
      const restarted = new ShoppingLedger(ctx, env);
      expect(restarted.reserve(call, PRICE.version).status).toBe('duplicate');
      expect(db.select().from(reservations).get()?.charged).toBe(RESERVATION);
    });
    expect((await stub.reserve(correlation(), PRICE.version)).status).toBe(
      'reserved',
    );
    await stub.settle(reservation.id, {
      prompt_tokens: 1,
      completion_tokens: 1,
    });
    await runInDurableObject(stub, (_instance, ctx) => {
      expect(
        drizzle(ctx.storage)
          .select()
          .from(reservations)
          .where(eq(reservations.id, reservation.id))
          .get(),
      ).toMatchObject({ month: '2000-01', status: 'settled', charged: 650 });
    });
  });

  it('enforces six per minute across new sessions and sixty per rolling day atomically', async () => {
    const stub = ledger();
    const calls = await Promise.all(
      Array.from({ length: 10 }, () =>
        stub.admit('visitor', crypto.randomUUID(), crypto.randomUUID()),
      ),
    );
    expect(calls.filter(Boolean)).toHaveLength(6);
    for (let batch = 1; batch < 10; batch++) {
      await runInDurableObject(stub, (_instance, ctx) => {
        drizzle(ctx.storage)
          .update(starts)
          .set({ at: Date.now() - 61_000 })
          .run();
      });
      for (let n = 0; n < 6; n++)
        expect(
          await stub.admit('visitor', crypto.randomUUID(), crypto.randomUUID()),
        ).toBe(true);
    }
    await runInDurableObject(stub, (_instance, ctx) => {
      drizzle(ctx.storage)
        .update(starts)
        .set({ at: Date.now() - 61_000 })
        .run();
    });
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
    await expect(ledger().reserve(correlation(), 'unknown')).rejects.toThrow(
      'pricing_unavailable',
    );
  });
});
