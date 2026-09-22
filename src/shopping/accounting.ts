import { and, count, eq, gt, lte, max, sum } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle } from 'drizzle-orm/d1';
import { BudgetLedger, type Correlation } from './budget';
import type { Usage } from './pricing';
import {
  accountingRevisions,
  budgetAlerts,
  reservations,
  starts,
} from './storage/ledger-schema';

/** Commit each accounting decision against the revision read before its data. */
export class D1Accounting {
  constructor(private readonly binding: D1Database) {}

  private async commit<T>(
    operation: (ledger: BudgetLedger) => Promise<T>,
  ): Promise<T> {
    // Without the Sessions API, D1 sends all queries to the primary.
    const db = drizzle(this.binding);
    for (let attempt = 0; attempt <= 5; attempt++) {
      const revision =
        (
          await db
            .select({ value: max(accountingRevisions.revision) })
            .from(accountingRevisions)
            .get()
        )?.value ?? 0;
      const mutations: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
        db.insert(accountingRevisions).values({ revision: revision + 1 }),
      ];
      const ledger = new BudgetLedger({
        getStart: id => db.select().from(starts).where(eq(starts.id, id)).get(),
        async deleteStartsThrough(at) {
          mutations.push(db.delete(starts).where(lte(starts.at, at)));
        },
        async countStarts(visitor, after) {
          // Deletion is staged: explicitly exclude expired admissions from reads.
          return (
            (
              await db
                .select({ value: count() })
                .from(starts)
                .where(
                  and(
                    eq(starts.visitor, visitor),
                    gt(starts.at, after ?? Date.now() - 86_400_000),
                  ),
                )
                .get()
            )?.value ?? 0
          );
        },
        async insertStart(row) {
          mutations.push(db.insert(starts).values(row));
        },
        getReservation: id =>
          db.select().from(reservations).where(eq(reservations.id, id)).get(),
        async totalCharged(month) {
          return Number(
            (
              await db
                .select({ value: sum(reservations.charged) })
                .from(reservations)
                .where(eq(reservations.month, month))
                .get()
            )?.value ?? 0,
          );
        },
        async insertReservation(row) {
          mutations.push(db.insert(reservations).values(row));
        },
        async updateReservation(id, changes) {
          mutations.push(
            db.update(reservations).set(changes).where(eq(reservations.id, id)),
          );
        },
        async insertAlert(row) {
          mutations.push(
            db.insert(budgetAlerts).values(row).onConflictDoNothing(),
          );
        },
      });
      const result = await operation(ledger);
      try {
        await db.batch(mutations);
        return result;
      } catch (error) {
        const messages: string[] = [];
        let cause: unknown = error;
        while (cause instanceof Error) {
          messages.push(cause.message);
          cause = 'cause' in cause ? cause.cause : undefined;
        }
        if (
          !messages.some(message =>
            message.includes(
              'UNIQUE constraint failed: shopping_accounting_revisions.revision',
            ),
          )
        )
          throw error;
      }
    }
    throw new Error('accounting_unavailable');
  }

  admit(visitor: string, sessionId: string, runId: string) {
    return this.commit(ledger => ledger.admit(visitor, sessionId, runId));
  }
  reserve(correlation: Correlation, version: string) {
    return this.commit(ledger => ledger.reserve(correlation, version));
  }
  settle(id: string, usage: Usage) {
    return this.commit(ledger => ledger.settle(id, usage));
  }
}
