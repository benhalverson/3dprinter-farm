import { expect, test } from 'vitest';
import payments from '../../src/routes/payments';
import { mockEnv } from '../mocks/env';
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
test('Square ingress fails closed on missing signature configuration', async () => {
  expect(
    (
      await payments.request(
        '/webhook/square',
        { method: 'POST', body: '{}' },
        { ...mockEnv(), SQUARE_WEBHOOK_SIGNATURE_KEY: undefined },
      )
    ).status,
  ).toBe(503);
});
