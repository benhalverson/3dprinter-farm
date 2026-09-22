import { z } from 'zod';

export type BudgetEmailEnv = {
  BUDGET_EMAIL?: SendEmail;
  AGENT_BUDGET_FROM?: string;
  AGENT_BUDGET_TO?: string;
};

export const budgetEmailConfig = z.object({
  AGENT_BUDGET_FROM: z.string().email(),
  AGENT_BUDGET_TO: z.string().email(),
});

export type BudgetAlertMessage = {
  id: string;
  month: string;
  threshold: number;
  charged: number;
  exhausted: boolean;
};

export async function sendBudgetEmail(
  env: BudgetEmailEnv,
  alert: BudgetAlertMessage,
) {
  const config = budgetEmailConfig.parse(env);
  if (!env.BUDGET_EMAIL) throw new Error('budget_email_unconfigured');
  const amount = (alert.charged / 1_000_000_000).toFixed(2);
  const text = [
    `Lulu Speedworks inference budget: ${alert.threshold}% for ${alert.month} UTC.`,
    `Accounted amount: $${amount} of $20.00, including conservative reservations for usage not yet confirmed.`,
    alert.exhausted
      ? 'No further maximum-size inference invocation can be admitted. Direct shopping remains available.'
      : 'Direct shopping remains available. Inference is admitted only while its reservation fits the remaining budget.',
    'Late usage can lower the reserved amount. These admission controls are not a guarantee of the provider invoice.',
    `Alert reference: ${alert.id}`,
  ];
  const result = await env.BUDGET_EMAIL.send({
    from: config.AGENT_BUDGET_FROM,
    to: config.AGENT_BUDGET_TO,
    subject: `Lulu inference budget: ${alert.threshold}% (${alert.month})`,
    text: text.join('\n\n'),
    html: text.map(paragraph => `<p>${paragraph}</p>`).join(''),
    headers: { 'X-Lulu-Budget-Alert': alert.id },
  });
  if (!result.messageId) throw new Error('budget_email_unacknowledged');
  return result.messageId;
}
