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
    SQUARE_ACCESS_TOKEN: 'square-test-token',
    SQUARE_LOCATION_ID: 'square-test-location',
    SQUARE_WEBHOOK_SIGNATURE_KEY: 'square-test-signature-key',
    SQUARE_WEBHOOK_URL: 'https://example.com/webhook/square',
    SQUARE_ENVIRONMENT: 'sandbox',
    DOMAIN: 'example.com',
    COLOR_CACHE: {} as KVNamespace,
    RP_ID: 'example.com',
    RP_NAME: 'ExampleApp',
    RATE_LIMIT_KV: {} as KVNamespace,
    MAILJET_API_KEY: 'test-key',
    MAILJET_API_SECRET: 'test-secret',
    MAILJET_CONTACT_LIST_ID: 'test-list-id',
    MAILJET_TEMPLATE_ID: 'test-template-id',
    MAILJET_SENDER_EMAIL: 'test@example.com',
    MAILJET_SENDER_NAME: 'Test Sender',
    ENCRYPTION_PASSPHRASE: 'test-passphrase',
    R2_PUBLIC_BASE_URL: 'https://uploads.example.com',
    R2_PHOTO_BASE_URL: 'https://photos.example.com',
  };
}
