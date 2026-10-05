import { and, count, eq, gt, isNull, lte, sum } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/durable-sqlite';
import { claimAlert } from '../budget-alerts';
import type {
  AlertStorage,
  BudgetStorage,
  Reservation,
  Start,
} from './contracts';
import { budgetAlerts, reservations, starts } from './ledger-schema';

/** Bind accounting rules to the existing Durable Object's Drizzle database. */
export function budgetStore(db: ReturnType<typeof drizzle>): BudgetStorage {
  return {
    /** Ignore a threshold replay without replacing its original delivery state. */
    insertAlert(alert) {
      db.insert(budgetAlerts).values(alert).onConflictDoNothing().run();
    },
    /** Read the idempotent visitor admission marker. */
    getStart(id: string) {
      return db.select().from(starts).where(eq(starts.id, id)).get();
    },
    /** Expire limiter entries through the rolling cutoff. */
    deleteStartsThrough(at: number) {
      db.delete(starts).where(lte(starts.at, at)).run();
    },
    /** Count visitor starts, optionally within the short burst window. */
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
    /** Record an admitted run. */
    insertStart(start: Start) {
      db.insert(starts).values(start).run();
    },
    /** Read a reservation by its immutable invocation identity. */
    getReservation(id: string) {
      return db
        .select()
        .from(reservations)
        .where(eq(reservations.id, id))
        .get();
    },
    /** Sum conservative charges in one UTC-month bucket. */
    totalCharged(month: string) {
      return Number(
        db
          .select({ total: sum(reservations.charged) })
          .from(reservations)
          .where(eq(reservations.month, month))
          .get()?.total ?? 0,
      );
    },
    /** Persist maximum liability before provider admission. */
    insertReservation(reservation: Reservation) {
      db.insert(reservations).values(reservation).run();
    },
    /** Reconcile only the identified original reservation. */
    updateReservation(id: string, changes: Partial<Reservation>) {
      db.update(reservations).set(changes).where(eq(reservations.id, id)).run();
    },
  };
}

/** Claims and acknowledgements compare lease identity within the caller's transaction. */
export function alertStore(
  db: ReturnType<typeof drizzle>,
  transaction: <T>(work: () => T) => T,
): AlertStorage {
  return {
    /** Claim the earliest eligible alert before releasing transaction ownership. */
    claim(now, sender, recipient) {
      return transaction(() => {
        const row = db
          .select()
          .from(budgetAlerts)
          .where(
            and(
              isNull(budgetAlerts.messageId),
              lte(budgetAlerts.nextAttempt, now),
            ),
          )
          .orderBy(budgetAlerts.nextAttempt, budgetAlerts.id)
          .get();
        if (!row) return undefined;
        const claimed = claimAlert(row, now, sender, recipient);
        db.update(budgetAlerts)
          .set(claimed)
          .where(eq(budgetAlerts.id, row.id))
          .run();
        return claimed;
      });
    },
    /** Ignore acknowledgements from a superseded lease. */
    accept(id, lease, messageId) {
      transaction(() => {
        db.update(budgetAlerts)
          .set({ messageId, lease: null })
          .where(
            and(
              eq(budgetAlerts.id, id),
              eq(budgetAlerts.lease, lease),
              isNull(budgetAlerts.messageId),
            ),
          )
          .run();
      });
    },
    /** Include leased attempts so a crash cannot strand an unacknowledged notification. */
    nextAttempt() {
      return db
        .select({ at: budgetAlerts.nextAttempt })
        .from(budgetAlerts)
        .where(isNull(budgetAlerts.messageId))
        .orderBy(budgetAlerts.nextAttempt)
        .get()?.at;
    },
  };
}
