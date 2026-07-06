import { z } from 'zod';
import { DEFAULT_PLA_BLACK_FILAMENT_ID } from '../db/schema';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const readinessReasonSchema = z.enum([
  'product_missing',
  'missing_stripe_price_id',
  'missing_public_file_service_id',
  'invalid_quantity',
  'invalid_filament_id',
  'unavailable_filament_id',
]);

export const cartReadinessErrorSchema = z.object({
  cartItemId: z.number(),
  skuNumber: z.string().nullable(),
  reasons: z.array(readinessReasonSchema),
});

export const catalogProductReadinessSchema = z.object({
  productId: z.number(),
  skuNumber: z.string().nullable(),
  name: z.string().nullable(),
  checkoutReady: z.boolean(),
  reasons: z.array(readinessReasonSchema),
  stripePriceId: z.string().nullable(),
  publicFileServiceId: z.string().nullable(),
  defaultFilamentId: z.string(),
});

export const catalogReadinessResponseSchema = z.object({
  products: z.array(catalogProductReadinessSchema),
  summary: z.object({
    total: z.number(),
    ready: z.number(),
    notReady: z.number(),
  }),
});

export type ReadinessReason = z.infer<typeof readinessReasonSchema>;

export type CheckoutReadinessItem = {
  cartItemId: number;
  cartUserId?: string | null;
  skuNumber: string | null;
  quantity: number;
  filamentType?: string | null;
  filamentId: string | null;
  productSkuNumber?: string | null;
  stripePriceId?: string | null;
  publicFileServiceId?: string | null;
  price?: number | null;
  name?: string | null;
};

export type CartReadinessError = z.infer<typeof cartReadinessErrorSchema>;

export type CatalogReadinessProduct = {
  id: number;
  skuNumber: string | null;
  name: string | null;
  stripePriceId: string | null;
  publicFileServiceId: string | null;
};

async function loadAvailableFilamentIds(env: {
  COLOR_CACHE?: KVNamespace;
}): Promise<Set<string> | undefined> {
  const cache = env.COLOR_CACHE;
  if (!cache?.get) return undefined;

  const cached =
    (await cache.get('v2:colors:all:true:all')) ??
    (await cache.get('v2:colors:all:all:all'));
  if (!cached) return undefined;

  try {
    const parsed = JSON.parse(cached) as {
      data?: Array<{ publicId?: string; available?: boolean }>;
    };
    if (!Array.isArray(parsed.data)) return undefined;

    return new Set(
      parsed.data
        .filter(filament => filament.available !== false)
        .map(filament => filament.publicId)
        .filter((publicId): publicId is string => typeof publicId === 'string'),
    );
  } catch {
    return undefined;
  }
}

function filamentReasons(
  filamentId: string,
  availableFilamentIds: Set<string> | undefined,
): ReadinessReason[] {
  if (!UUID_PATTERN.test(filamentId)) {
    return ['invalid_filament_id'];
  }

  if (availableFilamentIds && !availableFilamentIds.has(filamentId)) {
    return ['unavailable_filament_id'];
  }

  return [];
}

export function readinessErrorResponse(errors: CartReadinessError[]) {
  return {
    error: 'Cart is not ready for checkout',
    items: errors,
  };
}

export async function validateCartReadiness(
  env: { COLOR_CACHE?: KVNamespace },
  items: CheckoutReadinessItem[],
): Promise<CartReadinessError[]> {
  const availableFilamentIds = await loadAvailableFilamentIds(env);
  const errors: CartReadinessError[] = [];

  for (const item of items) {
    const reasons: ReadinessReason[] = [];
    const filamentId = item.filamentId || DEFAULT_PLA_BLACK_FILAMENT_ID;

    if (!item.productSkuNumber) {
      reasons.push('product_missing');
    }
    if (!item.stripePriceId) {
      reasons.push('missing_stripe_price_id');
    }
    if (!item.publicFileServiceId) {
      reasons.push('missing_public_file_service_id');
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      reasons.push('invalid_quantity');
    }
    reasons.push(...filamentReasons(filamentId, availableFilamentIds));

    if (reasons.length > 0) {
      errors.push({
        cartItemId: item.cartItemId,
        skuNumber: item.skuNumber,
        reasons,
      });
    }
  }

  return errors;
}

export async function evaluateCatalogReadiness(
  env: { COLOR_CACHE?: KVNamespace },
  products: CatalogReadinessProduct[],
) {
  const availableFilamentIds = await loadAvailableFilamentIds(env);
  const readinessProducts = products.map(product => {
    const reasons: ReadinessReason[] = [];

    if (!product.stripePriceId) {
      reasons.push('missing_stripe_price_id');
    }
    if (!product.publicFileServiceId) {
      reasons.push('missing_public_file_service_id');
    }
    reasons.push(
      ...filamentReasons(DEFAULT_PLA_BLACK_FILAMENT_ID, availableFilamentIds),
    );

    return {
      productId: product.id,
      skuNumber: product.skuNumber,
      name: product.name,
      checkoutReady: reasons.length === 0,
      reasons,
      stripePriceId: product.stripePriceId,
      publicFileServiceId: product.publicFileServiceId,
      defaultFilamentId: DEFAULT_PLA_BLACK_FILAMENT_ID,
    };
  });

  const ready = readinessProducts.filter(
    product => product.checkoutReady,
  ).length;

  return {
    products: readinessProducts,
    summary: {
      total: readinessProducts.length,
      ready,
      notReady: readinessProducts.length - ready,
    },
  };
}
