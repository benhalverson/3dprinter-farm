import { expect, test, vi } from 'vitest';
import app from '../src/app';
import { mockEnv } from './mocks/env';

test.each(['', 'short', '   '])('health rejects unusable auth secret %j', async secret => {
  const response = await app.request('/health', {}, { ...mockEnv(), BETTER_AUTH_SECRET: secret });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('short');
});
test.each(['', 'invalid', 'http://api.example.com', 'https://user:password@api.example.com'])('rejects invalid required auth URL %s', async url => {
  expect((await app.request('/health', {}, { ...mockEnv(), AUTH_BASE_URL: url })).status).toBe(503);
});
test('does not require JWT and reports disabled optional webhook without side effects', async () => {
  const env = mockEnv();
  delete env.JWT_SECRET;
  delete env.SLANT_WEBHOOK_SECRET;
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    const response = await app.request('/ready', {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', features: { slantWebhook: 'disabled', square: 'ready', squareWebhook: 'ready' } });
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
test('reports configured webhook readiness and rejects partial provider configuration', async () => {
  expect(await (await app.request('/ready', {}, mockEnv())).json()).toMatchObject({ features: { slantWebhook: 'ready' } });
  expect((await app.request('/health', {}, { ...mockEnv(), SQUARE_ACCESS_TOKEN: '' })).status).toBe(503);
  expect((await app.request('/health', {}, { ...mockEnv(), SQUARE_WEBHOOK_NOTIFICATION_URL: 'invalid' })).status).toBe(503);
});
test('liveness is independent of configuration readiness', async () => {
  expect((await app.request('/live', {}, {})).status).toBe(200);
  expect((await app.request('/ready', {}, {})).status).toBe(503);
});
