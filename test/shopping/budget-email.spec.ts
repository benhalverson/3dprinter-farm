import { describe, expect, it, vi } from 'vitest';
import { sendBudgetEmail } from '../../src/shopping/budget-email';

const alert = {
  id: 'lulu-inference-2026-09-50',
  month: '2026-09',
  threshold: 50,
  charged: 10_200_000_000,
  exhausted: false,
};
const config = {
  AGENT_BUDGET_FROM: 'budget@example.test',
  AGENT_BUDGET_TO: 'owner@example.test',
};

describe('Cloudflare budget email binding', () => {
  it('sends a transactional budget alert through the native binding', async () => {
    const send = vi
      .fn<SendEmail['send']>()
      .mockResolvedValue({ messageId: 'accepted-1' });
    expect(
      await sendBudgetEmail({ ...config, BUDGET_EMAIL: { send } }, alert),
    ).toBe('accepted-1');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: config.AGENT_BUDGET_FROM,
        to: config.AGENT_BUDGET_TO,
        subject: 'Lulu inference budget: 50% (2026-09)',
        text: expect.stringContaining('$10.20 of $20.00'),
        html: expect.stringContaining(
          'not a guarantee of the provider invoice',
        ),
        headers: { 'X-Lulu-Budget-Alert': alert.id },
      }),
    );
  });
  it('reports admission exhaustion without claiming confirmed provider spend', async () => {
    const send = vi
      .fn<SendEmail['send']>()
      .mockResolvedValue({ messageId: 'accepted-2' });
    await sendBudgetEmail(
      { ...config, BUDGET_EMAIL: { send } },
      { ...alert, threshold: 100, exhausted: true },
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'No further maximum-size inference invocation can be admitted',
        ),
      }),
    );
  });
  it('rejects missing configuration, unacknowledged sends and binding failures', async () => {
    await expect(sendBudgetEmail({}, alert)).rejects.toThrow();
    await expect(sendBudgetEmail(config, alert)).rejects.toThrow(
      'unconfigured',
    );
    const send = vi
      .fn<SendEmail['send']>()
      .mockResolvedValue({ messageId: '' });
    await expect(
      sendBudgetEmail({ ...config, BUDGET_EMAIL: { send } }, alert),
    ).rejects.toThrow('unacknowledged');
    send.mockRejectedValueOnce(new Error('E_SENDER_NOT_VERIFIED'));
    await expect(
      sendBudgetEmail({ ...config, BUDGET_EMAIL: { send } }, alert),
    ).rejects.toThrow('E_SENDER_NOT_VERIFIED');
  });
});
