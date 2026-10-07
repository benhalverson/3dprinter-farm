import 'zod-openapi/extend';
import { z } from 'zod';
import { slantDraft } from './slantOrderContracts';
import { BASE_URL_V2 } from '../constants';

// Numeric safety bound, not a store price or shipping policy.
export const MAX_SHIPPING_COST_USD = Math.floor(Number.MAX_SAFE_INTEGER / 100);

/**
 * Converts confirmed USD major units to exact, safe integer cents.
 * Rejects fractional cents, unsafe magnitudes and decimal-to-number precision loss.
 */
export function shippingUsdCents(value: number | string): number | undefined {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return undefined;
  const cents = Number(`${match[1]}${(match[2] ?? '').padEnd(2, '0')}`);
  const dollars = Number(value);
  if (
    !Number.isSafeInteger(cents) ||
    dollars > MAX_SHIPPING_COST_USD ||
    cents / 100 !== dollars ||
    Math.round(dollars * 100) !== cents
  )
    return undefined;
  return cents;
}

export const shippingEstimateSchema = z.object({
  shippingCost: z
    .number()
    .finite()
    .nonnegative()
    .max(MAX_SHIPPING_COST_USD)
    .describe(
      'Shipping estimate in USD major units (dollars), with at most two decimal places. Account currency confirmed by the owner. Convert validated values to safe integer cents using Math.round(shippingCost * 100). Not a persisted or payable quote.',
    )
    .refine(
      value => shippingUsdCents(value) !== undefined,
      'Expected exact USD cents',
    ),
});

export const shippingErrorSchema = z.object({ error: z.string() });

const requiredText = z.string().trim().min(1);
export const shippingProfileSchema = z.object({
  email: z.string().trim().email(),
  firstName: requiredText,
  lastName: requiredText,
  shippingAddress: requiredText,
  city: requiredText,
  state: requiredText,
  zipCode: requiredText,
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/),
});

/** Maps saved profile fields to the existing Slant3D V2 draft request shape. */
export function mapShippingAddress(
  profile: z.infer<typeof shippingProfileSchema>,
) {
  return {
    name: `${profile.firstName} ${profile.lastName}`,
    line1: profile.shippingAddress,
    line2: '',
    city: profile.city,
    state: profile.state,
    zip: profile.zipCode,
    country: profile.country.toUpperCase(),
  };
}

// Official V2 Orders examples document these two fields. Older aliases have no
// established units and are deliberately excluded from this contract.
// https://slant3dapi.com/documentation/orders
const amountFields = [
  {
    path: ['data', 'order', 'deliveryCost'],
    schema: z.string().regex(/^\d+\.\d{2}$/),
  },
  {
    path: ['data', 'totals', 'deliveryCost'],
    schema: z.number().finite().nonnegative(),
  },
];

/** Reads an own-property path without treating arrays or inherited fields as DTOs. */
function readPath(source: unknown, path: string[]): unknown {
  let value = source;
  for (const key of path) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getOwnPropertyDescriptor(value, key) === undefined
    )
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Validates documented V2 USD costs and compares their exact integer cents. */
export function parseShippingEstimate(source: unknown) {
  let amountCents: number | undefined;
  for (const field of amountFields) {
    const raw = readPath(source, field.path);
    if (raw === undefined) continue;
    const value = field.schema.safeParse(raw);
    if (!value.success) throw new Error('Invalid shipping estimate');
    const cents = shippingUsdCents(value.data);
    if (
      cents === undefined ||
      (amountCents !== undefined && amountCents !== cents)
    ) {
      throw new Error('Invalid shipping estimate');
    }
    amountCents = cents;
  }
  return shippingEstimateSchema.parse({
    shippingCost: amountCents === undefined ? undefined : amountCents / 100,
  });
}

export type ShippingDraft = {
  platformId: string;
  ownerId: string;
  customer: {
    details: { email: string; address: ReturnType<typeof mapShippingAddress> };
  };
  items: Array<{
    type: 'PRINT';
    publicFileServiceId: string;
    filamentId: string;
    quantity: number;
  }>;
};

/**
 * Requests only the existing provider draft estimate, never payment/fulfillment.
 * Owns the timeout and response body; callers receive no raw upstream errors.
 */
export async function requestShippingEstimate(
  payload: ShippingDraft,
  apiKey: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${BASE_URL_V2}orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(slantDraft(payload)),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Shipping provider rejected the estimate');
    }
    return parseShippingEstimate(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}
