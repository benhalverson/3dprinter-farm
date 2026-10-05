import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { BudgetLedger, type Correlation } from './budget';
import { BudgetCoordinator } from './budget-coordinator';
import type { BudgetEmailEnv } from './budget-email';
import type { Usage } from './pricing';
import { alertStore, budgetStore } from './storage/budget-store';
import migrations from './storage/migrations';

export type { Correlation, Reservation } from './budget';

/** Private deployment-account ledger; all accounting/outbox changes use synchronous transactions. */
export class ShoppingLedger extends DurableObject {
  private readonly ledger: BudgetLedger;
  private readonly coordinator: BudgetCoordinator;

  /** Initialize Drizzle and recover pending delivery scheduling before admitting RPCs. */
  constructor(ctx: DurableObjectState, env: Cloudflare.Env & BudgetEmailEnv) {
    super(ctx, env);
    const db = drizzle(ctx.storage);
    this.ledger = new BudgetLedger(budgetStore(db));
    this.coordinator = new BudgetCoordinator(
      this.ledger,
      alertStore(db, work => ctx.storage.transactionSync(work)),
      {
        exclusive: work => ctx.blockConcurrencyWhile(work),
        transaction: work => ctx.storage.transactionSync(work),
        getAlarm: () => ctx.storage.getAlarm(),
        setAlarm: at => ctx.storage.setAlarm(at),
        deleteAlarm: () => ctx.storage.deleteAlarm(),
      },
      env,
    );
    ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations);
      await this.coordinator.resume();
    });
  }

  /** Enforce the shared visitor limiter before a run starts. */
  admit(visitor: string, sessionId: string, runId: string) {
    return this.ctx.storage.transactionSync(() =>
      this.ledger.admit(visitor, sessionId, runId),
    );
  }

  /** Atomically reserve the ceiling and thresholds, after ensuring durable delivery scheduling. */
  reserve(correlation: Correlation, version: string) {
    return this.coordinator.reserve(correlation, version);
  }

  /** Missing usage never refunds a reservation; late valid usage belongs to the original month. */
  settle(id: string, usage?: Usage | null) {
    return this.coordinator.settle(id, usage);
  }

  /** Retry pending budget email notifications independently of shopper traffic. */
  alarm() {
    return this.coordinator.alarm();
  }
}
