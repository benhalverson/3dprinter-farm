import { describe, expect, test } from 'vitest';
import { squareConfig, squareWebhookConfig, verifySquareSignature } from '../../src/lib/square';
import { mockEnv } from '../mocks/env';

const config = {
  SQUARE_ENVIRONMENT: 'sandbox' as const,
  SQUARE_ACCESS_TOKEN: 'test-token',
  SQUARE_MERCHANT_ID: 'merchant',
  SQUARE_LOCATION_ID: 'location',
  SQUARE_WEBHOOK_SIGNATURE_KEY: 'test-signature-key',
  SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://api.example/webhook/square',
};
const bindings = { ...mockEnv(), ...config };
const configurationFailure = {
  kind: 'square_failure',
  code: 'square_configuration_required',
  uncertain: false,
};
const settings = [
  'SQUARE_ENVIRONMENT',
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_MERCHANT_ID',
  'SQUARE_LOCATION_ID',
  'SQUARE_WEBHOOK_SIGNATURE_KEY',
  'SQUARE_WEBHOOK_NOTIFICATION_URL',
] as const;

describe.each(settings)('required Square setting %s', setting => {
  test.each([undefined, '', ' \t\n '])('rejects %j', value => {
    expect(() => squareConfig({ ...bindings, [setting]: value })).toThrow(
      expect.objectContaining(configurationFailure),
    );
  });

  test('validates configuration before checking the signature', async () => {
    const env = mockEnv();
    delete env[setting];
    for (const signature of [undefined, 'invalid']) {
      await expect(
        verifySquareSignature('{}', signature, env),
      ).rejects.toEqual(configurationFailure);
    }
  });
});

test.each(['sandbox', 'production'] as const)(
  'accepts complete %s configuration',
  environment => {
    expect(
      squareConfig({ ...bindings, SQUARE_ENVIRONMENT: environment }),
    ).toEqual({ ...config, SQUARE_ENVIRONMENT: environment });
  },
);

test.each([
  'not-a-url',
  '/webhook/square',
  '//api.example/webhook/square',
  'http://api.example/webhook/square',
  'https://user:password@api.example/webhook/square',
  'https://api.example/webhook/square#fragment',
])(
  'rejects invalid notification URL %s',
  url => {
    expect(() =>
      squareConfig({ ...bindings, SQUARE_WEBHOOK_NOTIFICATION_URL: url }),
    ).toThrow(expect.objectContaining(configurationFailure));
  },
);

test('preserves webhook strings while trimming API credentials and identifiers', () => {
  const webhook = {
    SQUARE_WEBHOOK_SIGNATURE_KEY: ' \ttest-signature-key\n ',
    SQUARE_WEBHOOK_NOTIFICATION_URL:
      ' https://API.example:443/webhook/%73quare?value=%2f ',
  };
  expect(squareWebhookConfig({ ...bindings, ...webhook })).toEqual({
    key: webhook.SQUARE_WEBHOOK_SIGNATURE_KEY,
    notificationURL: webhook.SQUARE_WEBHOOK_NOTIFICATION_URL,
  });
  expect(
    squareConfig({
      ...bindings,
      SQUARE_ACCESS_TOKEN: ' test-token ',
      SQUARE_MERCHANT_ID: ' merchant ',
      SQUARE_LOCATION_ID: ' location ',
      ...webhook,
    }),
  ).toEqual({ ...config, ...webhook });
});

/** Signs the supplied strings directly without passing through config validation. */
async function sign(body: string, key: string, url: string) {
  const signingKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      signingKey,
      new TextEncoder().encode(url + body),
    ),
  );
  return btoa(String.fromCharCode(...bytes));
}

test.each([
  {
    key: config.SQUARE_WEBHOOK_SIGNATURE_KEY,
    url: config.SQUARE_WEBHOOK_NOTIFICATION_URL,
  },
  {
    key: ' \ttest-signature-key\n ',
    url: ' https://API.example:443/webhook/%73quare?value=%2f ',
  },
])('verifies exact webhook bytes for $url', async ({ key, url }) => {
  const body = '{ "type": "payment.updated", "note": "café" }\n';
  const signature = await sign(body, key, url);
  const env = {
    ...bindings,
    SQUARE_WEBHOOK_SIGNATURE_KEY: key,
    SQUARE_WEBHOOK_NOTIFICATION_URL: url,
  };
  await expect(verifySquareSignature(body, signature, env)).resolves.toBe(true);
  await expect(
    verifySquareSignature(`${body} `, signature, env),
  ).resolves.toBe(false);
  await expect(
    verifySquareSignature(body, signature, {
      ...env,
      SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://api.example/other',
    }),
  ).resolves.toBe(false);
  await expect(
    verifySquareSignature(body, signature, {
      ...env,
      SQUARE_WEBHOOK_SIGNATURE_KEY: `${key}x`,
    }),
  ).resolves.toBe(false);
});

test.each([undefined, '', 'invalid', `${'A'.repeat(43)}=`])(
  'rejects invalid signature %j with complete configuration',
  async signature => {
    await expect(
      verifySquareSignature('{}', signature, bindings),
    ).resolves.toBe(false);
  },
);
