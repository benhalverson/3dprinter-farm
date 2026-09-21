import { DurableObject } from 'cloudflare:workers';
import { and, count, eq, gt, isNull, lte, min, sum } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/durable-objects/migrations';
import { BudgetLedger, type Correlation } from './budget';
import { claimAlert, flushBudgetAlerts } from './budget-alerts';
import type { BudgetEmailEnv } from './budget-email';
import type { Usage } from './pricing';
import type { AlertStorage, Reservation, Start } from './storage/contracts';
import { budgetAlerts, reservations, starts } from './storage/ledger-schema';

export type { Correlation, Reservation } from './budget';

/** Private deployment-account ledger; operations use synchronous transactions. */
export class ShoppingLedger extends DurableObject<
  Cloudflare.Env & BudgetEmailEnv
> {
  private readonly ledger: BudgetLedger;
  private readonly alerts: AlertStorage;
  constructor(ctx: DurableObjectState, env: Cloudflare.Env & BudgetEmailEnv) {
    super(ctx, env);
    const db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations);
      await this.arm();
    });
    this.alerts = {
      nextAttempt() {
        return (
          db
            .select({ at: min(budgetAlerts.nextAttempt) })
            .from(budgetAlerts)
            .where(isNull(budgetAlerts.messageId))
            .get()?.at ?? undefined
        );
      },
      claim(now, sender, recipient) {
        return ctx.storage.transactionSync(() => {
          const row = db
            .select()
            .from(budgetAlerts)
            .where(
              and(
                isNull(budgetAlerts.messageId),
                lte(budgetAlerts.nextAttempt, now),
              ),
            )
            .orderBy(budgetAlerts.nextAttempt)
            .limit(1)
            .get();
          if (!row) return;
          const claimed = claimAlert(row, now, sender, recipient);
          db.update(budgetAlerts)
            .set(claimed)
            .where(eq(budgetAlerts.id, row.id))
            .run();
          return claimed;
        });
      },
      accept(id, lease, messageId) {
        db.update(budgetAlerts)
          .set({ messageId, lease: null })
          .where(and(eq(budgetAlerts.id, id), eq(budgetAlerts.lease, lease)))
          .run();
      },
    };
    this.ledger = new BudgetLedger({
      getStart(id: string) {
        return db.select().from(starts).where(eq(starts.id, id)).get();
      },
      deleteStartsThrough(at: number) {
        db.delete(starts).where(lte(starts.at, at)).run();
      },
      countStarts(visitor: string, after?: number) {
        return (
          db
            .select({ count: count() })
            .from(starts)
            .where(
              after === undefined
                ? eq(starts.visitor, visitor)
                : and(eq(starts.visitor, visitor), gt(starts.at, after)),
            )
            .get()?.count ?? 0
        );
      },
      insertStart(start: Start) {
        db.insert(starts).values(start).run();
      },
      getReservation(id: string) {
        return db
          .select()
          .from(reservations)
          .where(eq(reservations.id, id))
          .get();
      },
      totalCharged(month: string) {
        return Number(
          db
            .select({ total: sum(reservations.charged) })
            .from(reservations)
            .where(eq(reservations.month, month))
            .get()?.total ?? 0,
        );
      },
      insertReservation(reservation: Reservation) {
        db.insert(reservations).values(reservation).run();
      },
      updateReservation(id: string, changes: Partial<Reservation>) {
        db.update(reservations)
          .set(changes)
          .where(eq(reservations.id, id))
          .run();
      },
      insertAlert(alert) {
        db.insert(budgetAlerts).values(alert).onConflictDoNothing().run();
      },
    });
  }
  admit(visitor: string, sessionId: string, runId: string) {
    return this.ctx.storage.transactionSync(() =>
      this.ledger.admit(visitor, sessionId, runId),
    );
  }
  async reserve(correlation: Correlation, version: string) {
    // Persist a wake-up before a reservation can atomically insert alert rows.
    await this.arm(true);
    return this.ctx.storage.transactionSync(() =>
      this.ledger.reserve(correlation, version),
    );
  }
  settle(id: string, usage: Usage) {
    return this.ctx.storage.transactionSync(() =>
      this.ledger.settle(id, usage),
    );
  }

  private async arm(force = false) {
    const due = this.alerts.nextAttempt();
    if (due === undefined && !force) return;
    const at = Math.max(Date.now() + 60_000, due ?? 0);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  alarm() {
    return flushBudgetAlerts(this.alerts, this.env, at =>
      this.ctx.storage.setAlarm(at),
    );
  }
}
