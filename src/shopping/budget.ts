import {
  MONTHLY_CAP,
  PRICE,
  RESERVATION,
  type Usage,
  usageCost,
} from './pricing';
import type { BudgetStorage } from './storage/contracts';

export type Correlation = {
  sessionId: string;
  runId: string;
  invocation: number;
};
export type { Reservation } from './storage/contracts';

/** Budget rules shared by production persistence and storage-mocked tests. */
export class BudgetLedger {
  constructor(private readonly storage: BudgetStorage) {}

  admit(visitor: string, sessionId: string, runId: string) {
    const now = Date.now();
    const id = `${sessionId}/${runId}`;
    if (this.storage.getStart(id)) return true;
    this.storage.deleteStartsThrough(now - 86_400_000);
    const day = this.storage.countStarts(visitor);
    const minute = this.storage.countStarts(visitor, now - 60_000);
    if (minute >= 6 || day >= 60) return false;
    this.storage.insertStart({ id, visitor, at: now });
    return true;
  }

  reserve(correlation: Correlation, version: string) {
    if (version !== PRICE.version) throw new Error('pricing_unavailable');
    const { sessionId, runId, invocation } = correlation;
    if (!Number.isInteger(invocation) || invocation < 0 || invocation >= 3)
      throw new Error('invalid_invocation');
    const id = `${sessionId}/${runId}/${invocation}`;
    const month = new Date().toISOString().slice(0, 7);
    // A repeated reservation must never authorize a repeated provider request.
    if (this.storage.getReservation(id))
      return { status: 'duplicate' as const, id };
    const total = this.storage.totalCharged(month);
    if (total + RESERVATION > MONTHLY_CAP) {
      this.queueAlerts(month, total, true);
      return { status: 'exhausted' as const, id };
    }
    this.storage.insertReservation({
      id,
      month,
      sessionId,
      runId,
      invocation,
      model: PRICE.model,
      priceVersion: PRICE.version,
      inputRate: PRICE.inputRate,
      outputRate: PRICE.outputRate,
      maximum: RESERVATION,
      charged: RESERVATION,
      status: 'reserved',
      inputTokens: null,
      outputTokens: null,
    });
    this.queueAlerts(month, total + RESERVATION, false);
    return { status: 'reserved' as const, id };
  }

  private queueAlerts(month: string, charged: number, exhausted: boolean) {
    for (const threshold of [50, 75, 100]) {
      if (
        charged < (MONTHLY_CAP * threshold) / 100 &&
        !(threshold === 100 && exhausted)
      )
        continue;
      this.storage.insertAlert({
        id: `lulu-inference-${month}-${threshold}`,
        month,
        threshold,
        charged,
        exhausted,
        attempts: 0,
        nextAttempt: Date.now(),
        lease: null,
        sender: null,
        recipient: null,
        messageId: null,
      });
    }
  }

  settle(id: string, usage: Usage) {
    const cost = usageCost(usage);
    const record = this.storage.getReservation(id);
    if (!record) throw new Error('unknown_reservation');
    if (record.status === 'settled') return record.charged;
    if (record.priceVersion !== PRICE.version || cost > record.maximum)
      throw new Error('invalid_usage');
    this.storage.updateReservation(id, {
      charged: cost,
      status: 'settled',
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
    });
    return cost;
  }
}
