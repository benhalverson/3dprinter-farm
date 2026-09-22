import { claimAlert } from '../../src/shopping/budget-alerts';
import type {
  AlertStorage,
  BudgetAlert,
  BudgetStorage,
  PendingUsage,
  Reservation,
  Run,
  SessionStorage,
  Start,
  UsageStorage,
  Visit,
} from '../../src/shopping/storage/contracts';

/** Storage operations only. These fixtures do not emulate SQLite or durability. */
export class MemorySessionStorage implements SessionStorage {
  visit?: Visit;
  readonly runs = new Map<string, Run>();
  async getVisit() {
    return this.visit && { ...this.visit };
  }
  async insertVisit(visit: Visit) {
    if (this.visit) return false;
    this.visit = { ...visit };
    return true;
  }
  async updateVisit(id: string, changes: Partial<Visit>) {
    if (this.visit?.id === id) Object.assign(this.visit, changes);
  }
  async getRun(id: string) {
    const run = this.runs.get(id);
    return run && { ...run };
  }
  async insertRun(run: Run) {
    if (this.runs.has(run.id)) return false;
    this.runs.set(run.id, { ...run });
    return true;
  }
  async updateRun(id: string, changes: Partial<Run>) {
    const run = this.runs.get(id);
    if (run?.status === 'running') Object.assign(run, changes);
  }
  async interruptRuns() {
    for (const run of this.runs.values())
      if (run.status === 'running')
        Object.assign(run, { status: 'fallback', reason: 'interrupted' });
  }
}

export class MemoryBudgetStorage implements BudgetStorage, AlertStorage {
  readonly alerts = new Map<string, BudgetAlert>();
  readonly starts = new Map<string, Start>();
  readonly reservations = new Map<string, Reservation>();
  async getStart(id: string) {
    const start = this.starts.get(id);
    return start && { ...start };
  }
  async deleteStartsThrough(at: number) {
    for (const [id, start] of this.starts)
      if (start.at <= at) this.starts.delete(id);
  }
  async countStarts(visitor: string, after?: number) {
    return [...this.starts.values()].filter(
      start =>
        start.visitor === visitor && (after === undefined || start.at > after),
    ).length;
  }
  async insertStart(start: Start) {
    this.starts.set(start.id, { ...start });
  }
  async getReservation(id: string) {
    const record = this.reservations.get(id);
    return record && { ...record };
  }
  async totalCharged(month: string) {
    return [...this.reservations.values()]
      .filter(record => record.month === month)
      .reduce((total, record) => total + record.charged, 0);
  }
  async insertReservation(record: Reservation) {
    if (this.reservations.has(record.id))
      throw new Error('duplicate_reservation');
    this.reservations.set(record.id, { ...record });
  }
  async updateReservation(id: string, changes: Partial<Reservation>) {
    const record = this.reservations.get(id);
    if (record) Object.assign(record, changes);
  }
  async insertAlert(alert: BudgetAlert) {
    if (!this.alerts.has(alert.id)) this.alerts.set(alert.id, { ...alert });
  }
  async nextAttempt() {
    const rows = [...this.alerts.values()].filter(row => !row.messageId);
    return rows.length
      ? Math.min(...rows.map(row => row.nextAttempt))
      : undefined;
  }
  async claim(now: number, sender: string | null, recipient: string | null) {
    const row = [...this.alerts.values()]
      .filter(row => !row.messageId && row.nextAttempt <= now)
      .sort((a, b) => a.nextAttempt - b.nextAttempt)[0];
    if (!row) return;
    const claimed = claimAlert(row, now, sender, recipient);
    this.alerts.set(row.id, claimed);
    return { ...claimed };
  }
  async accept(id: string, lease: string, messageId: string) {
    const row = this.alerts.get(id);
    if (row?.lease === lease) Object.assign(row, { messageId, lease: null });
  }
}

export class MemoryUsageStorage implements UsageStorage {
  readonly rows = new Map<string, PendingUsage>();
  async insertUsage(row: PendingUsage) {
    if (!this.rows.has(row.id)) this.rows.set(row.id, { ...row });
  }
  async getUsage(id: string) {
    return this.rows.get(id);
  }
  async deleteUsage(id: string) {
    this.rows.delete(id);
  }
  async listUsage() {
    return [...this.rows.values()];
  }
}
