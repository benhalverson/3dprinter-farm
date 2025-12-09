import type { Bindings } from '../../src/types';

export function mockEnv(): Bindings {
  return {
    DB: {} as D1Database,
    JWT_SECRET: 'test-secret',
    SLANT_API: 'fake-api-key',
    SLANT_API_V2: 'fake-api-key-v2',
    BUCKET: {} as R2Bucket,
    PHOTOS_BUCKET: {} as R2Bucket,
    STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_123',
    DOMAIN: 'example.com',
    COLOR_CACHE: {} as Cache,
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
  };
}
