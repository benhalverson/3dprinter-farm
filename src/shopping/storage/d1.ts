import { and, eq, isNull, lte, min } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { claimAlert } from '../budget-alerts';
import type { AlertStorage, SessionStorage, UsageStorage } from './contracts';
import { budgetAlerts } from './ledger-schema';
import { pendingUsage, runs, visits } from './visit-schema';

export function sessionStorage(
  binding: D1Database,
  sessionId: string,
): SessionStorage {
  const db = drizzle(binding);
  const runKey = (id: string) =>
    and(eq(runs.sessionId, sessionId), eq(runs.id, id));
  return {
    getVisit: () =>
      db.select().from(visits).where(eq(visits.id, sessionId)).get(),
    async insertVisit(visit) {
      if (visit.id !== sessionId) throw new Error('invalid_session');
      return (
        (
          await db
            .insert(visits)
            .values(visit)
            .onConflictDoNothing()
            .returning()
        ).length === 1
      );
    },
    async updateVisit(id, changes) {
      await db
        .update(visits)
        .set(changes)
        .where(and(eq(visits.id, sessionId), eq(visits.id, id)));
    },
    getRun: id => db.select().from(runs).where(runKey(id)).get(),
    async insertRun(run) {
      return (
        (
          await db
            .insert(runs)
            .values({ ...run, sessionId })
            .onConflictDoNothing()
            .returning()
        ).length === 1
      );
    },
    async updateRun(id, changes) {
      await db
        .update(runs)
        .set(changes)
        .where(and(runKey(id), eq(runs.status, 'running')));
    },
    async interruptRuns() {
      await db
        .update(runs)
        .set({ status: 'fallback', reason: 'interrupted' })
        .where(and(eq(runs.sessionId, sessionId), eq(runs.status, 'running')));
    },
  };
}

export function usageStorage(
  binding: D1Database,
  sessionId: string,
): UsageStorage {
  const db = drizzle(binding);
  const usageFields = {
    id: pendingUsage.id,
    inputTokens: pendingUsage.inputTokens,
    outputTokens: pendingUsage.outputTokens,
  };
  const key = (id: string) =>
    and(eq(pendingUsage.sessionId, sessionId), eq(pendingUsage.id, id));
  return {
    async insertUsage(row) {
      await db
        .insert(pendingUsage)
        .values({ ...row, sessionId })
        .onConflictDoNothing();
    },
    getUsage: id =>
      db.select(usageFields).from(pendingUsage).where(key(id)).get(),
    async deleteUsage(id) {
      await db.delete(pendingUsage).where(key(id));
    },
    listUsage: () =>
      db
        .select(usageFields)
        .from(pendingUsage)
        .where(eq(pendingUsage.sessionId, sessionId))
        .all(),
  };
}

export function alertStorage(binding: D1Database): AlertStorage {
  const db = drizzle(binding);
  return {
    async nextAttempt() {
      return (
        (
          await db
            .select({ at: min(budgetAlerts.nextAttempt) })
            .from(budgetAlerts)
            .where(isNull(budgetAlerts.messageId))
            .get()
        )?.at ?? undefined
      );
    },
    async claim(now, sender, recipient) {
      const row = await db
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
      return (
        await db
          .update(budgetAlerts)
          .set(claimed)
          .where(
            and(
              eq(budgetAlerts.id, row.id),
              isNull(budgetAlerts.messageId),
              eq(budgetAlerts.attempts, row.attempts),
              eq(budgetAlerts.nextAttempt, row.nextAttempt),
            ),
          )
          .returning()
      )[0];
    },
    async accept(id, lease, messageId) {
      await db
        .update(budgetAlerts)
        .set({ messageId, lease: null })
        .where(
          and(
            eq(budgetAlerts.id, id),
            eq(budgetAlerts.lease, lease),
            isNull(budgetAlerts.messageId),
          ),
        );
    },
  };
}
