import { z } from 'zod';
import type { Bindings } from '../types';

const squareMoneySchema = z.object({
  amount: z.number().int(),
  currency: z.string(),
});
const squarePaymentSchema = z.object({
  id: z.string(),
  order_id: z.string().optional(),
  status: z.string(),
  amount_money: squareMoneySchema,
});

const squarePaymentResponseSchema = z.object({ payment: squarePaymentSchema });
const squareRefundResponseSchema = z.object({
  refund: z.object({ id: z.string(), status: z.string() }),
});

export type SquarePayment = z.infer<typeof squarePaymentSchema>;

function squareOrigin(env: Pick<Bindings, 'SQUARE_ENVIRONMENT'>) {
  return env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

async function squareRequest<T>(
  env: Pick<
    Bindings,
    'SQUARE_ACCESS_TOKEN' | 'SQUARE_ENVIRONMENT' | 'SQUARE_API_VERSION'
  >,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`${squareOrigin(env)}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': env.SQUARE_API_VERSION ?? '2026-08-20',
    },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'errors' in payload
        ? JSON.stringify((payload as { errors: unknown }).errors)
        : `Square request failed with ${response.status}`;
    throw new Error(message);
  }
  return schema.parse(payload);
}

export async function createSquarePayment(
  env: Pick<
    Bindings,
    | 'SQUARE_ACCESS_TOKEN'
    | 'SQUARE_LOCATION_ID'
    | 'SQUARE_ENVIRONMENT'
    | 'SQUARE_API_VERSION'
  >,
  input: {
    sourceId: string;
    idempotencyKey: string;
    amountCents: number;
    cartId: string;
    customerEmail?: string;
  },
) {
  const result = await squareRequest(
    env,
    '/v2/payments',
    {
      source_id: input.sourceId,
      idempotency_key: input.idempotencyKey,
      amount_money: { amount: input.amountCents, currency: 'USD' },
      autocomplete: true,
      location_id: env.SQUARE_LOCATION_ID,
      reference_id: input.cartId,
      buyer_email_address: input.customerEmail,
      note: `Lulu Speedworks cart ${input.cartId}`,
    },
    squarePaymentResponseSchema,
  );
  return result.payment;
}

export async function refundSquarePayment(
  env: Pick<
    Bindings,
    'SQUARE_ACCESS_TOKEN' | 'SQUARE_ENVIRONMENT' | 'SQUARE_API_VERSION'
  >,
  input: { paymentId: string; idempotencyKey: string; amountCents: number },
) {
  const result = await squareRequest(
    env,
    '/v2/refunds',
    {
      payment_id: input.paymentId,
      idempotency_key: input.idempotencyKey,
      amount_money: { amount: input.amountCents, currency: 'USD' },
    },
    squareRefundResponseSchema,
  );
  return result.refund;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

export async function verifySquareWebhook(input: {
  rawBody: string;
  signature: string;
  notificationUrl: string;
  signatureKey: string;
}) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.signatureKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${input.notificationUrl}${input.rawBody}`),
  );
  const expected = new Uint8Array(signature);
  let received: Uint8Array;
  try {
    received = Uint8Array.from(atob(input.signature), character =>
      character.charCodeAt(0),
    );
  } catch {
    return false;
  }
  return constantTimeEqual(expected, received);
}
