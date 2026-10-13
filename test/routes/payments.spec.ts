import { beforeEach, expect, test, vi } from 'vitest';
import payments from '../../src/routes/payments';
import { mockEnv } from '../mocks/env';

const storage = vi.hoisted(() => ({ where: vi.fn() }));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({ from: () => ({ where: storage.where }) }),
  }),
}));

const cartId = '11111111-1111-4111-8111-111111111111';
const settings = [
  'SQUARE_ENVIRONMENT',
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_MERCHANT_ID',
  'SQUARE_LOCATION_ID',
  'SQUARE_WEBHOOK_SIGNATURE_KEY',
  'SQUARE_WEBHOOK_NOTIFICATION_URL',
] as const;

beforeEach(() => {
  vi.mocked(fetch).mockReset();
  storage.where.mockReset().mockResolvedValue([
    { id: cartId, userId: 'user_123' },
  ]);
});

test.each([
  '/success',
  '/cancel',
  '/webhook/stripe',
])('removes obsolete payment route %s', async path => {
  expect(
    (
      await payments.request(
        path,
        { method: path.includes('webhook') ? 'POST' : 'GET' },
        mockEnv(),
      )
    ).status,
  ).toBe(404);
});
test.each(settings)(
  'Square ingress returns 503 before checking the signature when %s is missing',
  async setting => {
    const response = await payments.request(
      '/webhook/square',
      { method: 'POST', body: '{}' },
      { ...mockEnv(), [setting]: undefined },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'square_configuration_required',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.where).not.toHaveBeenCalled();
  },
);

test.each(settings)(
  'checkout returns 503 without provider requests when %s is missing',
  async setting => {
    const response = await payments.request(
      `/cart/${cartId}/checkout`,
      {
        method: 'POST',
        headers: {
          Cookie: 'session=fixture',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteId: '22222222-2222-4222-8222-222222222222',
          requestKey: '33333333-3333-4333-8333-333333333333',
        }),
      },
      { ...mockEnv(), [setting]: undefined },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'square_configuration_required',
    });
    expect(fetch).not.toHaveBeenCalled();
    // Only the mocked cart-ownership read occurs before configuration validation.
    expect(storage.where).toHaveBeenCalledTimes(1);
  },
);
