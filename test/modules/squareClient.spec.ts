import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createSquarePayment,
  refundSquarePayment,
  verifySquareWebhook,
} from '../../src/modules/squareClient';

const env = {
  SQUARE_ACCESS_TOKEN: 'token',
  SQUARE_LOCATION_ID: 'location',
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_API_VERSION: '2026-08-20',
} as const;

afterEach(() => vi.unstubAllGlobals());

describe('Square client', () => {
  test('creates an authoritative server-side payment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          payment: {
            id: 'payment-1',
            order_id: 'order-1',
            status: 'COMPLETED',
            amount_money: { amount: 1999, currency: 'USD' },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createSquarePayment(env, {
        sourceId: 'card-token',
        idempotencyKey: 'request-1',
        amountCents: 1999,
        cartId: 'cart-1',
      }),
    ).resolves.toMatchObject({ id: 'payment-1', status: 'COMPLETED' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://connect.squareupsandbox.com/v2/payments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      source_id: 'card-token',
      idempotency_key: 'request-1',
      amount_money: { amount: 1999, currency: 'USD' },
      location_id: 'location',
    });
  });

  test('refunds the original Square payment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ refund: { id: 'refund-1', status: 'COMPLETED' } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      refundSquarePayment(env, {
        paymentId: 'payment-1',
        idempotencyKey: 'refund-request-1',
        amountCents: 1999,
      }),
    ).resolves.toEqual({ id: 'refund-1', status: 'COMPLETED' });
  });

  test('validates Square webhook signatures', async () => {
    const rawBody = JSON.stringify({ event_id: 'event-1' });
    const notificationUrl = 'https://example.com/webhook/square';
    const signatureKey = 'signature-key';
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(signatureKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const digest = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${notificationUrl}${rawBody}`),
    );
    const signature = btoa(String.fromCharCode(...new Uint8Array(digest)));

    await expect(
      verifySquareWebhook({ rawBody, signature, notificationUrl, signatureKey }),
    ).resolves.toBe(true);
    await expect(
      verifySquareWebhook({
        rawBody: `${rawBody} `,
        signature,
        notificationUrl,
        signatureKey,
      }),
    ).resolves.toBe(false);
  });
});
