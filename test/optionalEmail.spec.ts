import { expect, test, vi } from 'vitest';
import app from '../src/app';
import { mockEnv } from './mocks/env';

test('health and local browsing require no Mailjet credentials', async () => {
  const env = mockEnv();
  delete env.MAILJET_API_KEY;
  delete env.MAILJET_API_SECRET;
  delete env.MAILJET_CONTACT_LIST_ID;
  delete env.MAILJET_TEMPLATE_ID;
  delete env.MAILJET_SENDER_EMAIL;
  delete env.MAILJET_SENDER_NAME;
  const response = await app.request('/health', {}, env);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('unconfigured newsletter signup does not write a lead or call a provider', async () => {
  const env = mockEnv();
  delete env.MAILJET_API_KEY;
  const fetch = vi.spyOn(globalThis, 'fetch');
  const response = await app.request(
    '/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Local test', email: 'local@example.test' }),
    },
    env,
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Newsletter signup is unavailable',
  });
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});
