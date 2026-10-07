import { authConfiguration } from '../config/auth';
import { squareConfig, squareWebhookConfig } from '../lib/square';
import type { Bindings } from '../types';

const CORE = ['DB', 'BUCKET', 'PHOTO_BUCKET', 'COLOR_CACHE', 'RATE_LIMIT_KV', 'AUTH_BASE_URL', 'ENCRYPTION_PASSPHRASE', 'R2_PUBLIC_BASE_URL', 'R2_PHOTO_BASE_URL'] as const;
function configured(value: unknown) { return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined; }
/** Checks configuration only; no provider calls or readiness side effects. */
export function featureReadiness(env: Record<string, unknown>) {
  const feature = (keys: string[], validate?: () => unknown) => {
    if (!keys.some(key => configured(env[key]))) return 'disabled';
    if (!keys.every(key => configured(env[key]))) return 'unready';
    try { validate?.(); return 'ready'; } catch { return 'unready'; }
  };
  return {
    square: feature(['SQUARE_ENVIRONMENT', 'SQUARE_ACCESS_TOKEN', 'SQUARE_MERCHANT_ID', 'SQUARE_LOCATION_ID'], () => squareConfig(env as unknown as Bindings)),
    squareWebhook: feature(['SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_WEBHOOK_NOTIFICATION_URL'], () => squareWebhookConfig(env as unknown as Bindings)),
    slant: feature(['SLANT_API_V2', 'SLANT_PLATFORM_ID']),
    slantWebhook: configured(env.SLANT_WEBHOOK_SECRET) ? (configured(env.SLANT_PLATFORM_ID) ? 'ready' : 'unready') : 'disabled',
  };
}
/** Authenticated core readiness; fully absent integrations are explicitly disabled. */
export function validateBindings(env: Record<string, unknown>): void {
  const missing = CORE.filter(key => !configured(env[key]));
  if (missing.length) throw new Error(`Missing required bindings: ${missing.join(', ')}`);
  authConfiguration(env as unknown as Bindings);
  if (Object.values(featureReadiness(env)).includes('unready')) throw new Error('Incomplete or invalid integration configuration');
}
