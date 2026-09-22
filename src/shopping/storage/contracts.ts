import type { budgetAlerts, reservations, starts } from './ledger-schema';
import type { pendingUsage, runs, visits } from './visit-schema';

export type Visit = typeof visits.$inferSelect;
export type Run = Omit<typeof runs.$inferSelect, 'sessionId'>;
export type Reservation = typeof reservations.$inferSelect;
export type Start = typeof starts.$inferSelect;
export type BudgetAlert = typeof budgetAlerts.$inferSelect;
export type PendingUsage = Omit<typeof pendingUsage.$inferSelect, 'sessionId'>;

export interface UsageStorage {
  insertUsage(usage: PendingUsage): Promise<void>;
  getUsage(id: string): Promise<PendingUsage | undefined>;
  deleteUsage(id: string): Promise<void>;
  listUsage(): Promise<PendingUsage[]>;
}

export interface AlertStorage {
  nextAttempt(): Promise<number | undefined>;
  claim(
    now: number,
    sender: string | null,
    recipient: string | null,
  ): Promise<BudgetAlert | undefined>;
  accept(id: string, lease: string, messageId: string): Promise<void>;
}

export interface SessionStorage {
  getVisit(): Promise<Visit | undefined>;
  insertVisit(visit: Visit): Promise<boolean>;
  updateVisit(id: string, changes: Partial<Visit>): Promise<void>;
  getRun(id: string): Promise<Run | undefined>;
  insertRun(run: Run): Promise<boolean>;
  updateRun(id: string, changes: Partial<Run>): Promise<void>;
  interruptRuns(): Promise<void>;
}

export interface BudgetStorage {
  getStart(id: string): Promise<Start | undefined>;
  deleteStartsThrough(at: number): Promise<void>;
  countStarts(visitor: string, after?: number): Promise<number>;
  insertStart(start: Start): Promise<void>;
  getReservation(id: string): Promise<Reservation | undefined>;
  totalCharged(month: string): Promise<number>;
  insertReservation(reservation: Reservation): Promise<void>;
  updateReservation(id: string, changes: Partial<Reservation>): Promise<void>;
  insertAlert(alert: BudgetAlert): Promise<void>;
}
