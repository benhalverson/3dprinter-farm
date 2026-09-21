import { type Usage, usageSchema } from './pricing';
import type { PendingUsage, UsageStorage } from './storage/contracts';

export type ReconciliationTasks = {
  schedule(payload: PendingUsage): Promise<{ id: string }>;
  cancel(id: string): Promise<boolean>;
};

/** Only token counts and the original reservation ID are durable. Never retry inference. */
export class UsageReconciler {
  constructor(
    private readonly storage: UsageStorage,
    private readonly tasks: ReconciliationTasks,
    private readonly settle: (id: string, usage: Usage) => Promise<number>,
  ) {}

  async restore() {
    for (const row of this.storage.listUsage()) await this.tasks.schedule(row);
  }

  async record(id: string, usage: Usage) {
    const valid = usageSchema.parse(usage);
    const payload = {
      id,
      inputTokens: valid.prompt_tokens,
      outputTokens: valid.completion_tokens,
    };
    // The SDK persists the payload before the first ledger RPC. A crash between
    // scheduling and writing the outbox can still recover those exact counts.
    const task = await this.tasks.schedule(payload);
    return this.reconcile(payload, task.id);
  }

  async reconcile(payload: PendingUsage, taskId: string) {
    this.storage.insertUsage(payload);
    const row = this.storage.getUsage(payload.id);
    if (!row) throw new Error('usage_unavailable');
    const charged = await this.settle(row.id, {
      prompt_tokens: row.inputTokens,
      completion_tokens: row.outputTokens,
    });
    this.storage.deleteUsage(row.id);
    // Cancel this invocation's task only: another late result has its own task.
    await this.tasks.cancel(taskId);
    return charged;
  }
}
