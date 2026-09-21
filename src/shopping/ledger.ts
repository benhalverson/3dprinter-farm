import { DurableObject } from 'cloudflare:workers';
import { and, count, eq, gt, lte, sum } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/shopping-ledger/migrations';
import {
  MONTHLY_CAP,
  PRICE,
  RESERVATION,
  type Usage,
  usageCost,
} from './pricing';
import { reservations, starts } from './storage/ledger-schema';

export type Correlation = {
  sessionId: string;
  runId: string;
  invocation: number;
};
export type Reservation = typeof reservations.$inferSelect;

/** Private deployment-account ledger. No network I/O inside synchronous transactions. */
export class ShoppingLedger extends DurableObject {
  private db;
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  admit(visitor: string, sessionId: string, runId: string) {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const id = `${sessionId}/${runId}`;
      if (this.db.select().from(starts).where(eq(starts.id, id)).get())
        return true;
      this.db
        .delete(starts)
        .where(lte(starts.at, now - 86_400_000))
        .run();
      const day =
        this.db
          .select({ count: count() })
          .from(starts)
          .where(eq(starts.visitor, visitor))
          .get()?.count ?? 0;
      const minute =
        this.db
          .select({ count: count() })
          .from(starts)
          .where(and(eq(starts.visitor, visitor), gt(starts.at, now - 60_000)))
          .get()?.count ?? 0;
      if (minute >= 6 || day >= 60) return false;
      this.db.insert(starts).values({ id, visitor, at: now }).run();
      return true;
    });
  }

  reserve(correlation: Correlation, version: string) {
    if (version !== PRICE.version) throw new Error('pricing_unavailable');
    const { sessionId, runId, invocation } = correlation;
    if (!Number.isInteger(invocation) || invocation < 0 || invocation >= 3)
      throw new Error('invalid_invocation');
    const id = `${sessionId}/${runId}/${invocation}`;
    const month = new Date().toISOString().slice(0, 7);
    return this.ctx.storage.transactionSync(() => {
      // A repeated reservation must never authorize a repeated provider request.
      if (
        this.db.select().from(reservations).where(eq(reservations.id, id)).get()
      )
        return { status: 'duplicate' as const, id };
      const total = Number(
        this.db
          .select({ total: sum(reservations.charged) })
          .from(reservations)
          .where(eq(reservations.month, month))
          .get()?.total ?? 0,
      );
      if (total + RESERVATION > MONTHLY_CAP)
        return { status: 'exhausted' as const, id };
      this.db
        .insert(reservations)
        .values({
          id,
          month,
          sessionId,
          runId,
          invocation,
          model: PRICE.model,
          priceVersion: PRICE.version,
          inputRate: PRICE.inputRate,
          outputRate: PRICE.outputRate,
          maximum: RESERVATION,
          charged: RESERVATION,
          status: 'reserved',
        })
        .run();
      return { status: 'reserved' as const, id };
    });
  }

  settle(id: string, usage: Usage) {
    const cost = usageCost(usage);
    return this.ctx.storage.transactionSync(() => {
      const record = this.db
        .select()
        .from(reservations)
        .where(eq(reservations.id, id))
        .get();
      if (!record) throw new Error('unknown_reservation');
      if (record.status === 'settled') return record.charged;
      if (record.priceVersion !== PRICE.version || cost > record.maximum)
        throw new Error('invalid_usage');
      this.db
        .update(reservations)
        .set({
          charged: cost,
          status: 'settled',
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
        })
        .where(eq(reservations.id, id))
        .run();
      return cost;
    });
  }
}
