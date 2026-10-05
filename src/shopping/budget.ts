import {
  MONTHLY_CAP,
  PRICE,
  RESERVATION,
  type Usage,
  usageSchema,
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
  /** Use the transaction-scoped persistence owned by the deployment ledger. */
  constructor(private readonly storage: BudgetStorage) {}

  /** Idempotently admit a run within the rolling visitor limits. */
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

  /** Reserve the full invocation ceiling and enqueue all newly crossed thresholds atomically. */
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

  /** Preserve missing usage; reconcile the first valid report against its original bucket and rates. */
  settle(id: string, usage?: Usage | null) {
    const record = this.storage.getReservation(id);
    if (!record) throw new Error('unknown_reservation');
    let charged = record.charged;
    if (usage != null) {
      const valid = usageSchema.parse(usage);
      const cost =
        valid.prompt_tokens * record.inputRate +
        valid.completion_tokens * record.outputRate;
      if (!Number.isSafeInteger(cost) || cost < 0 || cost > record.maximum)
        throw new Error('invalid_usage');
      // A replay cannot release more capacity or reprice a completed reservation.
      if (record.status !== 'settled') {
        charged = cost;
        this.storage.updateReservation(id, {
          charged: cost,
          status: 'settled',
          inputTokens: valid.prompt_tokens,
          outputTokens: valid.completion_tokens,
        });
      }
    }
    this.queueAlerts(
      record.month,
      this.storage.totalCharged(record.month),
      false,
    );
    return charged;
  }

  /** Retain the first crossing even if later usage releases reserved capacity. */
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
        exhausted: threshold === 100 && exhausted,
        attempts: 0,
        nextAttempt: Date.now(),
        lease: null,
        sender: null,
        recipient: null,
        messageId: null,
      });
    }
  }
}
