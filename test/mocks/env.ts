import type { Bindings } from '../../src/types';

export function mockEnv(): Bindings {
  return {
    DB: {} as D1Database,
    JWT_SECRET: 'test-secret',
    BETTER_AUTH_SECRET: 'test-secret-key-minimum-32-characters-long',
    SLANT_API: 'fake-api-key',
    SLANT_API_V2: 'fake-api-key-v2',
    SLANT_PLATFORM_ID: 'test-platform-id',
    SLANT_WEBHOOK_SECRET: 'test-slant-webhook-secret',
    BUCKET: {} as R2Bucket,
    PHOTO_BUCKET: {} as R2Bucket,
    SQUARE_ENVIRONMENT: 'sandbox',
    SQUARE_ACCESS_TOKEN: 'test',
    SQUARE_MERCHANT_ID: 'merchant',
    SQUARE_LOCATION_ID: 'location',
    SQUARE_WEBHOOK_SIGNATURE_KEY: 'signature',
    SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://api.example/webhook/square',
    DOMAIN: 'example.com',
    COLOR_CACHE: {} as KVNamespace,
    RP_ID: 'example.com',
    RP_NAME: 'ExampleApp',
    RATE_LIMIT_KV: {} as KVNamespace,
    ENCRYPTION_PASSPHRASE: 'test-passphrase',
    R2_PUBLIC_BASE_URL: 'https://uploads.example.com',
    R2_PHOTO_BASE_URL: 'https://photos.example.com',
  };
}
