import { expect, test, vi } from 'vitest';
import app from '../src/app';
import { mockEnv } from './mocks/env';

test('health works with the supported bindings', async () => {
  const response = await app.request('/health', {}, mockEnv());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test.each([
  '/email',
  '/email/confirm/local@example.test',
  '/admin/orders/1/resend-notification',
])('removed legacy endpoint %s makes no provider calls', async path => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    const response = await app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Local test',
          email: 'local@example.test',
        }),
      },
      mockEnv(),
    );
    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
