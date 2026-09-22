import {
  type BudgetEmailEnv,
  budgetEmailConfig,
  sendBudgetEmail,
} from './budget-email';
import type { AlertStorage, BudgetAlert } from './storage/contracts';

/** Persist retry ownership before sending. Provider acceptance is not exactly-once delivery. */
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

export async function flushBudgetAlerts(
  storage: AlertStorage,
  env: BudgetEmailEnv,
) {
  const config = budgetEmailConfig.safeParse(env);
  for (let n = 0; n < 10; n++) {
    const alert = await storage.claim(
      Date.now(),
      config.success ? config.data.AGENT_BUDGET_FROM : null,
      config.success ? config.data.AGENT_BUDGET_TO : null,
    );
    if (!alert?.lease) break;
    try {
      const messageId = await sendBudgetEmail(
        {
          BUDGET_EMAIL: env.BUDGET_EMAIL,
          AGENT_BUDGET_FROM: alert.sender ?? undefined,
          AGENT_BUDGET_TO: alert.recipient ?? undefined,
        },
        alert,
      );
      await storage.accept(alert.id, alert.lease, messageId);
      console.log(
        JSON.stringify({
          event: 'shopping_budget_alert',
          month: alert.month,
          threshold: alert.threshold,
          status: 'accepted',
        }),
      );
    } catch {
      console.log(
        JSON.stringify({
          event: 'shopping_budget_alert',
          month: alert.month,
          threshold: alert.threshold,
          status: 'retry',
        }),
      );
    }
  }
}
