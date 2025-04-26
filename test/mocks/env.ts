import type { Bindings } from '../../src/types';

export function mockEnv(): Bindings {
	return {
		DB: {} as D1Database,
		JWT_SECRET: 'test-secret',
		SLANT_API: 'fake-api-key',
		BUCKET: {} as R2Bucket,
		STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
		STRIPE_SECRET_KEY: 'sk_test_123',
		STRIPE_WEBHOOK_SECRET: 'whsec_123',
		STRIPE_PRICE_ID: 'price_123',
		DOMAIN: 'example.com',
		COLOR_CACHE: {} as Cache,
		RP_ID: 'example.com',
		RP_NAME: 'ExampleApp',
		RATE_LIMIT_KV: {} as KVNamespace,
	};
}
