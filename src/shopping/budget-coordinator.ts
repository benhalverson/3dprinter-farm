import { BudgetLedger, type Correlation } from './budget';
import { flushBudgetAlerts } from './budget-alerts';
import type { BudgetEmailEnv } from './budget-email';
import type { Usage } from './pricing';
import type { AlertStorage } from './storage/contracts';

export type BudgetRuntime = {
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  transaction: <T>(work: () => T) => T;
  getAlarm: () => Promise<number | null>;
  setAlarm: (at: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
};

/** Couple synchronous accounting/outbox commits with a pre-armed durable wakeup. */
export class BudgetCoordinator {
  /** Accept runtime-owned scheduling and persistence, keeping network sends outside the gate. */
  constructor(
    private readonly ledger: BudgetLedger,
    private readonly alerts: AlertStorage,
    private readonly runtime: BudgetRuntime,
    private readonly env: BudgetEmailEnv,
  ) {}

  /** Re-arm old pending rows on activation without moving an existing alarm. */
  async resume() {
    if (this.alerts.nextAttempt() !== undefined) await this.arm();
  }

  /** Fail closed before accounting changes if durable wakeup scheduling is unavailable. */
  reserve(correlation: Correlation, version: string) {
    return this.runtime.exclusive(async () => {
      await this.arm();
      return this.runtime.transaction(() =>
        this.ledger.reserve(correlation, version),
      );
    });
  }

  /** Reconcile original-month usage and threshold notifications in one transaction. */
  settle(id: string, usage?: Usage | null) {
    return this.runtime.exclusive(async () => {
      await this.arm();
      return this.runtime.transaction(() => this.ledger.settle(id, usage));
    });
  }

  /** Keep a recovery alarm during delivery, then schedule the earliest remaining attempt. */
  async alarm() {
    await this.runtime.exclusive(() =>
      this.runtime.setAlarm(Date.now() + 60_000),
    );
    await flushBudgetAlerts(this.alerts, this.env);
    await this.runtime.exclusive(async () => {
      const next = this.alerts.nextAttempt();
      if (next === undefined) await this.runtime.deleteAlarm();
      else await this.runtime.setAlarm(Math.max(Date.now() + 1000, next));
    });
  }

  /** Run only under the runtime's exclusive gate; commit the alarm before any new outbox row. */
  private async arm() {
    const current = await this.runtime.getAlarm();
    const soon = Date.now() + 1000;
    if (current === null || current > soon) await this.runtime.setAlarm(soon);
  }
}
