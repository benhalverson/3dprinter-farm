import { expect, test, vi } from 'vitest';
import { createPaidOrderFulfillment } from '../../src/modules/paidOrderFulfillment';
test('persisted payment authority is required before any provider effect', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          all: async () => [
            { id: 1, paymentStatus: 'pending', fulfillmentType: 'slant' },
          ],
        }),
      }),
    }),
  };
  try {
    await createPaidOrderFulfillment({
      db: db as never,
      env: {} as never,
    }).fulfillPaidOrder(1);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
