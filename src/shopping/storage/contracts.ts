import type { reservations, starts } from './ledger-schema';
import type { runs, visits } from './visit-schema';

export type Visit = typeof visits.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Reservation = typeof reservations.$inferSelect;
export type Start = typeof starts.$inferSelect;

export interface SessionStorage {
  getVisit(): Visit | undefined;
  insertVisit(visit: Visit): void;
  updateVisit(id: string, changes: Partial<Visit>): void;
  getRun(id: string): Run | undefined;
  insertRun(run: Run, ignoreConflict?: boolean): void;
  updateRun(id: string, changes: Partial<Run>): void;
  interruptRuns(): void;
}

export interface BudgetStorage {
  getStart(id: string): Start | undefined;
  deleteStartsThrough(at: number): void;
  countStarts(visitor: string, after?: number): number;
  insertStart(start: Start): void;
  getReservation(id: string): Reservation | undefined;
  totalCharged(month: string): number;
  insertReservation(reservation: Reservation): void;
  updateReservation(id: string, changes: Partial<Reservation>): void;
}
