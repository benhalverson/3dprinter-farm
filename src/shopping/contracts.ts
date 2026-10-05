import { z } from 'zod';

export const MAX_BYTES = 32 * 1024;
export const RUN_MS = 30_000;
export const IDLE_MS = 30 * 60_000;
export const LIFE_MS = 4 * 60 * 60_000;
export const runSchema = z
  .object({
    runId: z.string().uuid(),
    uiRevision: z.number().int().nonnegative().safe(),
    message: z.string().trim().min(1).max(8192),
    context: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(8192),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export type RunInput = z.infer<typeof runSchema>;
export const fallbackSchema = z.enum([
  'disabled',
  'inference_unavailable',
  'accounting_unavailable',
  'budget_exhausted',
  'rate_limited',
  'invalid_output',
  'catalog_unavailable',
  'timeout',
  'cancelled',
  'superseded',
  'disconnected',
  'interrupted',
  'tool_limit',
]);
export type Fallback = z.infer<typeof fallbackSchema>;
export class ShoppingFailure extends Error {
  constructor(readonly reason: Fallback) {
    super(reason);
  }
}
export function bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

/** Limit the body while reading, including chunked requests without Content-Length. */
export async function boundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0;
  let result = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new RangeError('body_too_large');
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function digest(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(buffer), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function networkKey(ip: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(ip));
  return Array.from(new Uint8Array(signed), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
