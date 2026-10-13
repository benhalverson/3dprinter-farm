import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

describe('Square readiness', () => {
  const apiSettings = [
    'SQUARE_ENVIRONMENT',
    'SQUARE_ACCESS_TOKEN',
    'SQUARE_MERCHANT_ID',
    'SQUARE_LOCATION_ID',
  ] as const;
  const webhookSettings = [
    'SQUARE_WEBHOOK_SIGNATURE_KEY',
    'SQUARE_WEBHOOK_NOTIFICATION_URL',
  ] as const;
  const settings = [...apiSettings, ...webhookSettings];

  beforeEach(() => {
    vi.mocked(fetch).mockClear();
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
  });

  async function expectReadiness(
    env: Record<string, unknown>,
    square: 'disabled' | 'unready' | 'ready',
  ) {
    const unready = square === 'unready';
    const ready = await app.request('/ready', {}, env);
    expect(ready.status).toBe(unready ? 503 : 200);
    expect(await ready.json()).toEqual({
      status: unready ? 'error' : 'ok',
      features: {
        square,
        squareWebhook: square,
        slant: 'ready',
        slantWebhook: 'ready',
      },
    });

    const health = await app.request('/health', {}, env);
    expect(health.status).toBe(unready ? 503 : 200);
    expect(await health.json()).toEqual(
      unready
        ? { status: 'error', message: 'Incomplete or invalid integration configuration' }
        : { status: 'ok' },
    );

    const live = await app.request('/live', {}, env);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
  }

  test('rejects webhook-only configuration', async () => {
    const env = mockEnv();
    for (const setting of apiSettings) delete env[setting];
    await expectReadiness(env, 'unready');
  });

  test('rejects API-only configuration', async () => {
    const env = mockEnv();
    for (const setting of webhookSettings) delete env[setting];
    await expectReadiness(env, 'unready');
  });

  describe.each(settings)('required setting %s', setting => {
    test.each([undefined, '', ' \t\n '])('rejects %j', async value => {
      await expectReadiness({ ...mockEnv(), [setting]: value }, 'unready');
    });
  });

  test('reports both features disabled when all Square settings are absent', async () => {
    const env = mockEnv();
    for (const setting of settings) delete env[setting];
    await expectReadiness(env, 'disabled');
  });

  test.each(['sandbox', 'production'] as const)(
    'reports both features ready with complete valid %s configuration',
    async environment => {
      await expectReadiness({ ...mockEnv(), SQUARE_ENVIRONMENT: environment }, 'ready');
    },
  );

  test('rejects an invalid Square environment', async () => {
    await expectReadiness({ ...mockEnv(), SQUARE_ENVIRONMENT: 'invalid' }, 'unready');
  });

  test.each([
    'invalid',
    '/webhook/square',
    'http://api.example/webhook/square',
    'https://user:password@api.example/webhook/square',
    'https://api.example/webhook/square#fragment',
  ])('rejects invalid webhook notification URL %s', async url => {
    await expectReadiness({ ...mockEnv(), SQUARE_WEBHOOK_NOTIFICATION_URL: url }, 'unready');
  });

  test('preserves accepted webhook signing strings', async () => {
    const webhook = {
      SQUARE_WEBHOOK_SIGNATURE_KEY: ' \ttest-signature-key\n ',
      SQUARE_WEBHOOK_NOTIFICATION_URL:
        ' https://API.example:443/webhook/%73quare?value=%2f ',
    };
    const env = { ...mockEnv(), ...webhook };
    await expectReadiness(env, 'ready');
    expect(env).toMatchObject(webhook);
  });
});

test('liveness is independent of configuration readiness', async () => {
  expect((await app.request('/live', {}, {})).status).toBe(200);
  expect((await app.request('/ready', {}, {})).status).toBe(503);
});
