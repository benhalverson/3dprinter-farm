import { Agent, type Schedule } from 'agents';
import { D1Accounting } from './accounting';
import { catalogReader } from './catalog';
import { PRICE } from './pricing';
import { UsageReconciler } from './reconciliation';
import { SessionHandler } from './session';
import type { PendingUsage } from './storage/contracts';
import { sessionStorage, usageStorage } from './storage/d1';

export type ShoppingEnv = Cloudflare.Env & { AGENT_NETWORK_SECRET?: string };

/** Production lifecycle and Drizzle persistence for a named shopping visit. */
export class ShoppingAgent extends Agent<ShoppingEnv> {
  private handler!: SessionHandler;
  private reconciliation!: UsageReconciler;

  async onStart() {
    const env = this.env;
    const ledger = new D1Accounting(env.DB);
    this.reconciliation = new UsageReconciler(
      usageStorage(env.DB, this.name),
      {
        schedule: payload => this.scheduleEvery(60, 'reconcileUsage', payload),
        cancel: id => this.cancelSchedule(id),
      },
      (id, usage) => ledger.settle(id, usage),
    );
    this.handler = new SessionHandler(sessionStorage(env.DB, this.name), {
      enabled: () => String(env.AGENT_ENABLED) === 'true',
      priceVersion: env.AGENT_PRICE_VERSION,
      ledger: () => ({
        admit: (visitor, sessionId, runId) =>
          ledger.admit(visitor, sessionId, runId),
        reserve: (correlation, version) => ledger.reserve(correlation, version),
        settle: (id, usage) => this.reconciliation.record(id, usage),
      }),
      read: query => catalogReader(env.DB)(query),
      infer: env.AI
        ? (payload, signal) => env.AI.run(PRICE.model, payload, { signal })
        : undefined,
      waitUntil: task => this.ctx.waitUntil(task),
    });
    await this.handler.onStart();
    await this.reconciliation.restore();
  }

  async reconcileUsage(payload: PendingUsage, task: Schedule<PendingUsage>) {
    try {
      await this.reconciliation.reconcile(payload, task.id);
    } catch {
      // The persisted interval retries without logging private provider errors.
      console.log(
        JSON.stringify({ event: 'shopping_reconciliation', status: 'retry' }),
      );
    }
  }

  onRequest(request: Request) {
    return this.handler.onRequest(request);
  }
}
