import { z } from 'zod';
import type { Bindings } from '../types';

export const SQUARE_API_VERSION = '2026-09-16';
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
/** Creates a sanitized provider failure without retaining sensitive response data. */
export function squareFailure(
  code: SquareFailure['code'],
  uncertain = false,
): SquareFailure {
  return { kind: 'square_failure', code, uncertain };
}
/** Narrows an unknown failure to the provider boundary’s documented error shape. */
export function isSquareFailure(value: unknown): value is SquareFailure {
  return squareFailureSchema.safeParse(value).success;
}

const configSchema = z.object({
  SQUARE_ENVIRONMENT: z.enum(['sandbox', 'production']),
  SQUARE_ACCESS_TOKEN: z.string().trim().min(1),
  SQUARE_MERCHANT_ID: z.string().trim().min(1),
  SQUARE_LOCATION_ID: z.string().trim().min(1),
});
/** Requires explicit environment, credentials, merchant, and location configuration. */
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
  /** Owns the request timeout and bounded response read, preserving uncertain outcomes. */
  async function request(
    path: string,
    payload?: string | FormData,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${origin}/v2/${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${config.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': SQUARE_API_VERSION,
          ...(payload instanceof FormData
            ? {}
            : { 'Content-Type': 'application/json' }),
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
  /** Rejects malformed or deleted catalog objects before they can confirm publication. */
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
    /** Creates or replays a hosted checkout with the persisted immutable payload and key. */
    async createPaymentLink(payload: unknown) {
      const result = z
        .object({
          payment_link: z.object({
            id: z.string().min(1),
            order_id: z.string().min(1),
            url: z.string().url(),
          }),
        })
        .safeParse(
          await request(
            'online-checkout/payment-links',
            JSON.stringify(payload),
          ),
        );
      if (!result.success) throw squareFailure('square_invalid_response', true);
      return result.data.payment_link;
    },
    /** Retrieves authoritative payment evidence rather than trusting event contents. */
    async retrievePayment(id: string) {
      const result = z
        .object({
          payment: z.object({
            id: z.string(),
            order_id: z.string(),
            location_id: z.string(),
            status: z.string(),
            application_details: z
              .object({ square_product: z.string().optional() })
              .optional(),
            amount_money: z.object({
              amount: z.number().int().safe(),
              currency: z.string(),
            }),
            total_money: z.object({
              amount: z.number().int().safe(),
              currency: z.string(),
            }),
          }),
        })
        .safeParse(await request(`payments/${encodeURIComponent(id)}`));
      if (!result.success || result.data.payment.id !== id)
        throw squareFailure('square_invalid_response');
      return result.data.payment;
    },
    /** Retrieves the original API order reference, including before a lost checkout response is recovered. */
    async retrieveOrder(id: string) {
      const result = z
        .object({
          order: z.object({
            id: z.string(),
            reference_id: z.string().default(''),
            line_items: z
              .array(
                z.object({
                  uid: z.string().optional(),
                  catalog_object_id: z.string().optional(),
                  name: z.string().optional(),
                  quantity: z.string(),
                  base_price_money: z
                    .object({
                      amount: z.number().int().safe(),
                      currency: z.string(),
                    })
                    .optional(),
                  total_money: z
                    .object({
                      amount: z.number().int().safe(),
                      currency: z.string(),
                    })
                    .optional(),
                }),
              )
              .optional(),
            location_id: z.string(),
            total_money: z.object({
              amount: z.number().int().safe(),
              currency: z.string(),
            }),
          }),
        })
        .safeParse(await request(`orders/${encodeURIComponent(id)}`));
      if (!result.success || result.data.order.id !== id)
        throw squareFailure('square_invalid_response');
      return result.data.order;
    },
    /** Confirms that the configured seller owns an active USD location. */
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
    /** Reads a complete mapped item and requires versioned, active variations. */
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
    /** Uploads the immutable primary image request with a browser-generated multipart boundary. */
    async createImage(
      metadata: string,
      bytes: ArrayBuffer,
      contentType: string,
    ) {
      if (contentType === 'image/webp') {
        const { PhotonImage } = await import('@cf-wasm/photon/workerd');
        try {
          const image = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
          try {
            bytes = image.get_bytes().slice().buffer;
          } finally {
            image.free();
          }
          contentType = 'image/png';
        } catch {
          throw squareFailure('square_request_rejected');
        }
      }
      if (
        !['image/jpeg', 'image/pjpeg', 'image/png', 'image/gif'].includes(
          contentType,
        ) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > 15_000_000
      )
        throw squareFailure('square_request_rejected');
      const form = new FormData();
      form.append('request', metadata);
      form.append(
        'file',
        new Blob([bytes], { type: contentType }),
        'primary-image',
      );
      const result = z
        .object({
          image: z
            .object({
              type: z.literal('IMAGE'),
              id: z
                .string()
                .min(1)
                .refine(id => !id.startsWith('#')),
              version,
              is_deleted: z.boolean().optional(),
              image_data: z.object({ url: z.string().url() }).passthrough(),
            })
            .passthrough(),
          errors: z.array(z.unknown()).length(0).optional(),
        })
        .safeParse(await request('catalog/images', form));
      if (!result.success || result.data.image.is_deleted)
        throw squareFailure('square_invalid_response', true);
      return result.data.image;
    },
    /** Sends the exact persisted payload so retries retain their idempotency key. */
    async upsert(payload: string) {
      return parseItem(await request('catalog/object', payload));
    },
  };
}

/** Side-effect-free webhook configuration shared with readiness. */
export function squareWebhookConfig(env: Bindings) {
  const key = env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim();
  const notificationURL = env.SQUARE_WEBHOOK_NOTIFICATION_URL?.trim();
  let url: URL;
  try { url = new URL(notificationURL || ''); } catch { throw squareFailure('square_configuration_required'); }
  if (!key || url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw squareFailure('square_configuration_required');
  return { key, notificationURL: notificationURL as string };
}

/** Verifies Square HMAC over the fixed subscription URL followed by the exact raw body. */
export async function verifySquareSignature(
  body: string,
  signature: string | undefined,
  env: Bindings,
) {
  const config = squareWebhookConfig(env);
  if (!signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
  return crypto.subtle.verify(
    'HMAC',
    key,
    bytes,
    new TextEncoder().encode(config.notificationURL + body),
  );
}
