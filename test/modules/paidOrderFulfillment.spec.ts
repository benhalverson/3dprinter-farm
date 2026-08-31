import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createPaidOrderFulfillment,
  type PaidOrderFulfillmentError,
  type PaidOrderItem,
  type PaidOrderProfile,
} from '../../src/modules/paidOrderFulfillment';

const profile: PaidOrderProfile = {
  email: 'customer@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  shippingAddress: '1 Main St',
  city: 'London',
  state: 'CA',
  zipCode: '90210',
  phone: '555-555-5555',
};

const item: PaidOrderItem = {
  id: 1,
  skuNumber: 'SKU-1',
  quantity: 2,
  color: 'BLUE',
  filamentType: 'PLA',
  filamentId: null,
  productName: 'Widget',
  productImage: null,
  productPrice: 4.5,
  stl: 'legacy.stl',
  publicFileServiceId: 'file-1',
};

function fakeDb() {
  const inserts: unknown[] = [];
  return {
    inserts,
    insert: (_table: unknown) => ({
      values: (value: unknown) => {
        inserts.push(value);
        return {
          returning: async () => [{ id: 42 }],
        };
      },
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('paid order fulfillment module', () => {
  test('drafts, processes, and records a paid order behind its interface', async () => {
    const db = fakeDb();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: { publicOrderId: 'slant-1' } }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 })),
    );

    const result = await createPaidOrderFulfillment({
      db: db as never,
      env: { SLANT_API_V2: 'token', SLANT_PLATFORM_ID: 'platform' },
      orderNumber: () => 'ORDER-1',
      clock: () => '2026-08-30T00:00:00.000Z',
    }).fulfillPaidOrder({
      fulfillment: {
        cartId: 'cart-1',
        userId: 'user-1',
        stripeEventId: 'evt-1',
        stripeObjectId: 'obj-1',
        stripePaymentIntentId: 'pi-1',
        idempotencyKey: 'pi-1',
      },
      profile,
      items: [item],
    });

    expect(result).toEqual({
      localOrderId: 42,
      publicOrderId: 'slant-1',
      orderNumber: 'ORDER-1',
    });
    expect(db.inserts).toHaveLength(2);
    expect(db.inserts[0]).toMatchObject({
      orderNumber: 'ORDER-1',
      totalAmountCents: 900,
    });
    expect((db.inserts[0] as { itemSnapshot: string }).itemSnapshot).toContain(
      '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
    );
  });

  test('reports the Slant lifecycle stage when processing fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: { publicOrderId: 'slant-1' } }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 502 })),
    );

    await expect(
      createPaidOrderFulfillment({
        db: fakeDb() as never,
        env: { SLANT_API_V2: 'token', SLANT_PLATFORM_ID: 'platform' },
      }).fulfillPaidOrder({
        fulfillment: {
          cartId: 'cart-1',
          userId: 'user-1',
          stripeEventId: 'evt-1',
          stripeObjectId: 'obj-1',
          idempotencyKey: 'pi-1',
        },
        profile,
        items: [item],
      }),
    ).rejects.toMatchObject({
      stage: 'process',
      status: 502,
    } satisfies Partial<PaidOrderFulfillmentError>);
  });
});
