import type {
  BudgetStorage,
  Reservation,
  Run,
  SessionStorage,
  Start,
  Visit,
} from '../../src/shopping/storage/contracts';

/** Storage operations only. These fixtures do not emulate SQLite or durability. */
export class MemorySessionStorage implements SessionStorage {
  visit?: Visit;
  readonly runs = new Map<string, Run>();
  getVisit() {
    return this.visit && { ...this.visit };
  }
  insertVisit(visit: Visit) {
    this.visit = { ...visit };
  }
  updateVisit(id: string, changes: Partial<Visit>) {
    if (this.visit?.id === id) Object.assign(this.visit, changes);
  }
  getRun(id: string) {
    const run = this.runs.get(id);
    return run && { ...run };
  }
  insertRun(run: Run, ignoreConflict = false) {
    if (this.runs.has(run.id)) {
      if (ignoreConflict) return;
      throw new Error('duplicate_run');
    }
    this.runs.set(run.id, { ...run });
  }
  updateRun(id: string, changes: Partial<Run>) {
    const run = this.runs.get(id);
    if (run) Object.assign(run, changes);
  }
  interruptRuns() {
    for (const run of this.runs.values())
      if (run.status === 'running')
        Object.assign(run, { status: 'fallback', reason: 'interrupted' });
  }
}

export class MemoryBudgetStorage implements BudgetStorage {
  readonly starts = new Map<string, Start>();
  readonly reservations = new Map<string, Reservation>();
  getStart(id: string) {
    const start = this.starts.get(id);
    return start && { ...start };
  }
  deleteStartsThrough(at: number) {
    for (const [id, start] of this.starts)
      if (start.at <= at) this.starts.delete(id);
  }
  countStarts(visitor: string, after?: number) {
    return [...this.starts.values()].filter(
      start =>
        start.visitor === visitor && (after === undefined || start.at > after),
    ).length;
  }
  insertStart(start: Start) {
    this.starts.set(start.id, { ...start });
  }
  getReservation(id: string) {
    const record = this.reservations.get(id);
    return record && { ...record };
  }
  totalCharged(month: string) {
    return [...this.reservations.values()]
      .filter(record => record.month === month)
      .reduce((total, record) => total + record.charged, 0);
  }
  insertReservation(record: Reservation) {
    if (this.reservations.has(record.id))
      throw new Error('duplicate_reservation');
    this.reservations.set(record.id, { ...record });
  }
  updateReservation(id: string, changes: Partial<Reservation>) {
    const record = this.reservations.get(id);
    if (record) Object.assign(record, changes);
  }
}
