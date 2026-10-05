import {
  type BudgetEmailEnv,
  budgetEmailConfig,
  sendBudgetEmail,
} from './budget-email';
import type { AlertStorage, BudgetAlert } from './storage/contracts';

/** Persist attempt ownership and exponential backoff before starting any delivery. */
export function claimAlert(
  row: BudgetAlert,
  now: number,
  sender: string | null,
  recipient: string | null,
): BudgetAlert {
  return {
    ...row,
    lease: crypto.randomUUID(),
    attempts: row.attempts + 1,
    nextAttempt:
      now + Math.min(3_600_000, 60_000 * 2 ** Math.min(row.attempts, 6)),
    sender: row.sender ?? sender,
    recipient: row.recipient ?? recipient,
  };
}

/** Bound stalled delivery without pretending that a timeout cancels provider acceptance. */
async function deliver(env: BudgetEmailEnv, alert: BudgetAlert) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sendBudgetEmail(env, alert),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('budget_email_timeout')),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Drain a bounded batch; failed/ambiguous sends keep the same durable logical alert. */
export async function flushBudgetAlerts(
  storage: AlertStorage,
  env: BudgetEmailEnv,
) {
  const config = budgetEmailConfig.safeParse(env);
  for (let n = 0; n < 10; n++) {
    const alert = storage.claim(
      Date.now(),
      config.success ? config.data.AGENT_BUDGET_FROM : null,
      config.success ? config.data.AGENT_BUDGET_TO : null,
    );
    if (!alert?.lease) break;
    const started = Date.now();
    let status = 'retry';
    try {
      const messageId = await deliver(
        {
          BUDGET_EMAIL: env.BUDGET_EMAIL,
          AGENT_BUDGET_FROM: alert.sender ?? undefined,
          AGENT_BUDGET_TO: alert.recipient ?? undefined,
        },
        alert,
      );
      storage.accept(alert.id, alert.lease, messageId);
      status = 'accepted';
    } catch {
      // Provider failures may contain addresses, credentials or message content.
    }
    console.log(
      JSON.stringify({
        event: 'shopping_budget_alert',
        month: alert.month,
        threshold: alert.threshold,
        status,
        latencyMs: Date.now() - started,
      }),
    );
  }
}
