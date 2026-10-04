import { z } from 'zod';
import { BASE_URL_V2 } from '../constants';

export const shippingEstimateSchema = z.object({
  shippingCost: z
    .number()
    .finite()
    .nonnegative()
    .describe(
      'Unconverted Slant3D provider amount. Currency and major/minor units are not verified by the available provider contract. Do not format as currency or use for payment until verified. This is not a payable quote.',
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

// Historical compatibility paths from the pre-188 adapter, not evidence of
// currency/units. Reject ambiguous values rather than selecting a guessed total.
const amountPaths = [
  ['shippingCost'],
  ['shipping_cost'],
  ['estimatedShippingCost'],
  ['deliveryCost'],
  ['data', 'shippingCost'],
  ['data', 'shipping_cost'],
  ['data', 'estimatedShippingCost'],
  ['data', 'deliveryCost'],
  ['data', 'shipping', 'shippingCost'],
  ['data', 'shipping', 'shipping_cost'],
  ['data', 'estimate', 'shippingCost'],
  ['data', 'estimate', 'shipping_cost'],
  ['data', 'estimatedCosts', 'shippingCost'],
  ['data', 'estimatedCosts', 'shipping_cost'],
  ['data', 'order', 'deliveryCost'],
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

/** Validates historical response shapes without guessing or converting provider units. */
export function parseShippingEstimate(source: unknown) {
  let amount: number | undefined;
  for (const path of amountPaths) {
    const raw = readPath(source, path);
    if (raw === undefined) continue;
    const candidate =
      typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim())
        ? Number(raw.trim())
        : raw;
    const parsed =
      shippingEstimateSchema.shape.shippingCost.safeParse(candidate);
    if (!parsed.success || (amount !== undefined && amount !== parsed.data)) {
      throw new Error('Invalid shipping estimate');
    }
    amount = parsed.data;
  }
  return shippingEstimateSchema.parse({ shippingCost: amount });
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
      body: JSON.stringify(payload),
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
