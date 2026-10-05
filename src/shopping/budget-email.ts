import { z } from 'zod';
import type { BudgetAlert } from './storage/contracts';

export type BudgetEmailEnv = {
  BUDGET_EMAIL?: SendEmail;
  AGENT_BUDGET_FROM?: string;
  AGENT_BUDGET_TO?: string;
};

export const budgetEmailConfig = z.object({
  AGENT_BUDGET_FROM: z.string().email(),
  AGENT_BUDGET_TO: z.string().email(),
});

/** Send only accounting metadata; the configured sender must be verified externally. */
export async function sendBudgetEmail(env: BudgetEmailEnv, alert: BudgetAlert) {
  const config = budgetEmailConfig.parse(env);
  if (!env.BUDGET_EMAIL) throw new Error('budget_email_unconfigured');
  const text = [
    alert.exhausted
      ? `Lulu Speedworks inference admission capacity exhausted for ${alert.month} UTC.`
      : `Lulu Speedworks inference budget: ${alert.threshold}% threshold for ${alert.month} UTC.`,
    `Accounted amount: USD ${(alert.charged / 1_000_000_000).toFixed(2)} of USD 20.00, including conservative reservations for unconfirmed usage.`,
    alert.exhausted
      ? 'Admission capacity is exhausted: the next maximum-size invocation does not fit. Accounted usage can be below USD 20.00. Direct shopping remains available.'
      : 'Direct shopping remains available. New inference is admitted only while its full reservation fits.',
    'Late usage may release reserved capacity. These application admission controls are not a provider billing guarantee.',
    `Logical alert reference: ${alert.id}`,
  ];
  const result = await env.BUDGET_EMAIL.send({
    from: config.AGENT_BUDGET_FROM,
    to: config.AGENT_BUDGET_TO,
    subject: alert.exhausted
      ? `Lulu inference admission capacity exhausted (${alert.month})`
      : `Lulu inference budget: ${alert.threshold}% (${alert.month})`,
    text: text.join('\n\n'),
    headers: { 'X-Lulu-Budget-Alert': alert.id },
  });
  if (!result.messageId) throw new Error('budget_email_unacknowledged');
  return result.messageId;
}
