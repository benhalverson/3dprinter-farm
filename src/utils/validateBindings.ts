/**
 * Validates that all required Cloudflare Worker bindings are present in the
 * runtime environment.  Call this once during Worker startup (e.g. in the
 * `fetch` handler or a top-level middleware) so misconfiguration fails fast
 * with a clear error message rather than producing cryptic runtime errors
 * deep inside request handlers.
 */

/**
 * Binding names that must be present for the worker to function.
 *
 * Keep this list in sync with the required (non-optional) fields of the
 * `Bindings` type in `src/types.ts` and the bindings declared in
 * `wrangler.toml` / `worker-configuration.d.ts`.
 * Optional bindings (`DB_PREVIEW`, `PASSKEY_ORIGIN`) are intentionally omitted.
 */
const REQUIRED_BINDINGS = [
  'DB',
  'BUCKET',
  'PHOTO_BUCKET',
  'COLOR_CACHE',
  'RATE_LIMIT_KV',
  'BETTER_AUTH_SECRET',
  'JWT_SECRET',
  'DOMAIN',
  'RP_ID',
  'RP_NAME',
  'SLANT_API',
  'SLANT_API_V2',
  'SLANT_PLATFORM_ID',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'MAILJET_API_KEY',
  'MAILJET_API_SECRET',
  'MAILJET_CONTACT_LIST_ID',
  'MAILJET_TEMPLATE_ID',
  'MAILJET_SENDER_EMAIL',
  'MAILJET_SENDER_NAME',
  'ENCRYPTION_PASSPHRASE',
  'R2_PUBLIC_BASE_URL',
  'R2_PHOTO_BASE_URL',
] as const;

/**
 * Throws an error listing every missing required binding.
 * If all required bindings are present, this is a no-op.
 *
 * @param env - The runtime environment object (e.g. `c.env` in a Hono handler)
 */
export function validateBindings(env: Record<string, unknown>): void {
  const missing = REQUIRED_BINDINGS.filter(
    key => env[key] === undefined || env[key] === null,
  );

  if (missing.length > 0) {
    throw new Error(
      `Worker misconfiguration – missing required bindings: ${missing.join(', ')}. ` +
        'Check wrangler.toml and ensure all secrets are set via `wrangler secret put`.',
    );
  }
}
