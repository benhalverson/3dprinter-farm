import { z } from 'zod';
import type { Bindings } from '../types';

export const SQUARE_API_VERSION = '2026-08-19';
const squareFailureSchema = z.object({
  kind: z.literal('square_failure'),
  code: z.enum([
    'square_configuration_required',
    'square_version_conflict',
    'square_request_rejected',
    'square_invalid_response',
    'square_outcome_unknown',
    'square_location_mismatch',
    'square_mapping_mismatch',
    'square_publication_response_mismatch',
  ]),
  uncertain: z.boolean(),
});
type SquareFailure = z.infer<typeof squareFailureSchema>;
export function squareFailure(
  code: SquareFailure['code'],
  uncertain = false,
): SquareFailure {
  return { kind: 'square_failure', code, uncertain };
}
export function isSquareFailure(value: unknown): value is SquareFailure {
  return squareFailureSchema.safeParse(value).success;
}

const configSchema = z.object({
  SQUARE_ENVIRONMENT: z.enum(['sandbox', 'production']),
  SQUARE_ACCESS_TOKEN: z.string().trim().min(1),
  SQUARE_MERCHANT_ID: z.string().trim().min(1),
  SQUARE_LOCATION_ID: z.string().trim().min(1),
});
export function squareConfig(env: Bindings) {
  const result = configSchema.safeParse(env);
  if (!result.success) throw squareFailure('square_configuration_required');
  return result.data;
}
export type SquareConfig = ReturnType<typeof squareConfig>;

const version = z.number().int().nonnegative().safe();
const variationSchema = z
  .object({
    type: z.literal('ITEM_VARIATION'),
    id: z.string().min(1),
    version: version.optional(),
    is_deleted: z.boolean().optional(),
    item_variation_data: z
      .object({
        item_id: z.string().min(1),
        location_overrides: z
          .array(z.object({ location_id: z.string().min(1) }).passthrough())
          .optional(),
        price_money: z
          .object({ amount: z.number().int().safe(), currency: z.string() })
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
export const squareItemSchema = z
  .object({
    type: z.literal('ITEM'),
    id: z.string().min(1),
    version,
    is_deleted: z.boolean().optional(),
    item_data: z
      .object({ variations: z.array(variationSchema).min(1) })
      .passthrough(),
  })
  .passthrough();
export type SquareItem = z.infer<typeof squareItemSchema>;

/** Only fixed codes cross the provider boundary; Square details can include secrets or seller data. */
export function squareClient(config: SquareConfig) {
  const origin =
    config.SQUARE_ENVIRONMENT === 'sandbox'
      ? 'https://connect.squareupsandbox.com'
      : 'https://connect.squareup.com';
  async function request(path: string, payload?: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${origin}/v2/${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${config.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': SQUARE_API_VERSION,
          'Content-Type': 'application/json',
        },
        body: payload,
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Timeouts, server errors, and throttling cannot prove that an earlier replay failed.
        throw squareFailure(
          response.status === 409
            ? 'square_version_conflict'
            : 'square_request_rejected',
          response.status >= 500 ||
            response.status === 408 ||
            response.status === 429,
        );
      }
      // Bound both body size and elapsed time, including body reads.
      const reader = response.body?.getReader();
      if (!reader) throw squareFailure('square_invalid_response', true);
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw squareFailure('square_invalid_response', true);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (isSquareFailure(error)) throw error;
      throw squareFailure('square_outcome_unknown', true);
    } finally {
      clearTimeout(timeout);
    }
  }
  function parseItem(data: unknown): SquareItem {
    const result = z
      .object({
        catalog_object: squareItemSchema,
        errors: z.array(z.unknown()).length(0).optional(),
      })
      .safeParse(data);
    if (!result.success || result.data.catalog_object.is_deleted) {
      throw squareFailure('square_invalid_response', true);
    }
    return result.data.catalog_object;
  }
  return {
    async validateLocation() {
      const result = z
        .object({
          location: z.object({
            id: z.string(),
            merchant_id: z.string(),
            currency: z.literal('USD'),
            status: z.literal('ACTIVE'),
          }),
        })
        .safeParse(
          await request(
            `locations/${encodeURIComponent(config.SQUARE_LOCATION_ID)}`,
          ),
        );
      if (
        !result.success ||
        result.data.location.id !== config.SQUARE_LOCATION_ID ||
        result.data.location.merchant_id !== config.SQUARE_MERCHANT_ID
      ) {
        throw squareFailure('square_location_mismatch');
      }
    },
    async retrieve(itemId: string) {
      const item = parseItem(
        await request(`catalog/object/${encodeURIComponent(itemId)}`),
      );
      if (
        item.id !== itemId ||
        item.item_data.variations.some(
          v => v.version === undefined || v.is_deleted,
        )
      ) {
        throw squareFailure('square_mapping_mismatch');
      }
      return item;
    },
    async upsert(payload: string) {
      return parseItem(await request('catalog/object', payload));
    },
  };
}
