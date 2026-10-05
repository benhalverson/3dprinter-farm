import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { BudgetStorage } from '../../src/shopping/storage/contracts';
import { ShoppingLedger } from '../../src/shopping/ledger';
import {
  budgetAlerts,
  reservations,
  starts,
} from '../../src/shopping/storage/ledger-schema';

/** Exercise production RPCs with an in-process email acknowledgement and no network. */
export class RestartLedger extends ShoppingLedger {
  constructor(
    ctx: DurableObjectState,
    env: Cloudflare.Env & { ACCEPT_EMAIL: boolean },
  ) {
    super(ctx, {
      ...env,
      AGENT_BUDGET_FROM: 'budget@example.test',
      AGENT_BUDGET_TO: 'owner@example.test',
      BUDGET_EMAIL: {
        async send() {
          if (!env.ACCEPT_EMAIL) throw new Error('controlled_failure');
          return { messageId: 'controlled-ack' };
        },
      },
    } as Cloudflare.Env);
  }

  /** Invoke the real alarm handler through an explicit test RPC. */
  runAlarm() {
    return this.alarm();
  }

  /** Inject a failure after a real outbox write inside production's synchronous transaction. */
  async failReserve(
    correlation: { sessionId: string; runId: string; invocation: number },
    version: string,
  ) {
    const storage = (this as unknown as { ledger: { storage: BudgetStorage } })
      .ledger.storage;
    const original = storage.insertAlert;
    storage.insertAlert = row => {
      original(row);
      throw new Error('injected_after_alert');
    };
    return this.reserve(correlation, version);
  }

  /** Inject a failure after a real reconciliation write, before its transaction commits. */
  async failSettle(id: string) {
    const storage = (this as unknown as { ledger: { storage: BudgetStorage } })
      .ledger.storage;
    const original = storage.updateReservation;
    storage.updateReservation = (id, row) => {
      original(id, row);
      throw new Error('injected_after_settlement');
    };
    return this.settle(id, { prompt_tokens: 10, completion_tokens: 2 });
  }

  /** Inspect persisted rows through Drizzle without replacing storage or queries. */
  async inspect() {
    const db = drizzle(this.ctx.storage);
    return {
      reservations: db.select().from(reservations).all(),
      alerts: db.select().from(budgetAlerts).all(),
      starts: db.select().from(starts).all(),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  /** Move a due retry forward deterministically instead of waiting a minute. */
  due() {
    drizzle(this.ctx.storage)
      .update(budgetAlerts)
      .set({ nextAttempt: 0 })
      .run();
  }

  /** Represent a retained reservation from an earlier UTC month for late reconciliation. */
  historical(id: string) {
    drizzle(this.ctx.storage)
      .update(reservations)
      .set({ month: '2020-01' })
      .where(eq(reservations.id, id))
      .run();
  }
}

export default {
  /** Route local test commands to one persisted production ledger instance. */
  async fetch(
    request: Request,
    env: { SHOPPING_LEDGER: DurableObjectNamespace<RestartLedger> },
  ) {
    const ledger = env.SHOPPING_LEDGER.get(
      env.SHOPPING_LEDGER.idFromName('account'),
    );
    const { operation, args = [] } = (await request.json()) as {
      operation: string;
      args?: unknown[];
    };
    const rpc = ledger as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    return Response.json((await rpc[operation](...args)) ?? null);
  },
};
