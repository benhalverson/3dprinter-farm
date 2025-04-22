export type Bindings = {
	BUCKET: R2Bucket;
	SLANT_API: string;
	STRIPE_PUBLISHABLE_KEY: string;
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
	STRIPE_PRICE_ID: string;
	DOMAIN: string;
	DB: D1Database;
	COLOR_CACHE: Cache;
	JWT_SECRET: string;
	RP_ID: string;
	RP_NAME: string;
	RATE_LIMIT_KV: KVNamespace;
};

