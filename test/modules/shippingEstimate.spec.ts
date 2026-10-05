import { afterEach, expect, test, vi } from 'vitest';
import {
  MAX_SHIPPING_COST_USD,
  shippingEstimateSchema,
  shippingUsdCents,
  parseShippingEstimate,
  requestShippingEstimate,
  type ShippingDraft,
} from '../../src/modules/shippingEstimate';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test.each([
  { order: { deliveryCost: '0.00' } },
  { order: { deliveryCost: '15.99' } },
  { totals: { deliveryCost: 15.99 } },
  { order: { deliveryCost: '15.99' }, totals: { deliveryCost: 15.99 } },
])('accepts documented V2 amount shapes %o without conversion', data => {
  const expected = data.order?.deliveryCost ?? data.totals?.deliveryCost;
  expect(parseShippingEstimate({ success: true, data })).toEqual({
    shippingCost: Number(expected),
  });
});
test.each([
  null,
  true,
  {},
  [],
  '',
  ' ',
  '-1.00',
  '0x10',
  '1e2',
  'NaN',
  'Infinity',
  -1,
  Infinity,
  NaN,
  '1',
  '1.2',
  '1.234',
  15.99,
])('rejects malformed order.deliveryCost %s', raw => {
  expect(() =>
    parseShippingEstimate({ data: { order: { deliveryCost: raw } } }),
  ).toThrow();
});
test.each([
  null,
  true,
  {},
  [],
  '',
  '15.99',
  -1,
  Infinity,
  NaN,
])('rejects malformed totals.deliveryCost %s', raw => {
  expect(() =>
    parseShippingEstimate({ data: { totals: { deliveryCost: raw } } }),
  ).toThrow();
});
test.each([
  null,
  [],
  {},
  { data: null },
  { data: [] },
  { data: { order: {} } },
])('rejects missing amount in %o', raw => {
  expect(() => parseShippingEstimate(raw)).toThrow();
});
test('rejects conflicting documented fields or malformed siblings', () => {
  expect(() =>
    parseShippingEstimate({
      data: { order: { deliveryCost: '1.00' }, totals: { deliveryCost: 100 } },
    }),
  ).toThrow();
  expect(() =>
    parseShippingEstimate({
      data: { order: { deliveryCost: null }, totals: { deliveryCost: 1 } },
    }),
  ).toThrow();
});
test('does not accept inherited amount fields', () => {
  expect(() =>
    parseShippingEstimate({
      data: { totals: Object.create({ deliveryCost: 10 }) },
    }),
  ).toThrow();
});
test('rejects historical aliases with unestablished units', () => {
  for (const key of [
    'shippingCost',
    'shipping_cost',
    'estimatedShippingCost',
    'deliveryCost',
  ]) {
    expect(() => parseShippingEstimate({ [key]: 1 })).toThrow();
    expect(() => parseShippingEstimate({ data: { [key]: '1' } })).toThrow();
  }
  for (const key of ['shipping', 'estimate', 'estimatedCosts']) {
    for (const field of ['shippingCost', 'shipping_cost']) {
      expect(() =>
        parseShippingEstimate({ data: { [key]: { [field]: '1' } } }),
      ).toThrow();
    }
  }
});
test('does not use unrelated aliases or item currency to change the USD amount', () => {
  expect(
    parseShippingEstimate({
      shippingCost: 1599,
      data: {
        totals: { deliveryCost: 15.99 },
        items: [{ currency: 'USD' }],
      },
    }),
  ).toEqual({ shippingCost: 15.99 });
});
test('owns timeout cancellation for a pending provider request', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    }),
  );
  const pending = requestShippingEstimate({} as ShippingDraft, 'test');
  const assertion = expect(pending).rejects.toThrow('aborted');
  await vi.advanceTimersByTimeAsync(15_000);
  await assertion;
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
test('cancels rejected response bodies and clears the timer', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(body, { status: 403 })),
  );
  await expect(
    requestShippingEstimate({} as ShippingDraft, 'test'),
  ).rejects.toThrow('rejected');
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
test('clears timeout after success and JSON failure', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { totals: { deliveryCost: 0 } } }),
      )
      .mockResolvedValueOnce(new Response('invalid')),
  );
  await expect(
    requestShippingEstimate({} as ShippingDraft, 'test'),
  ).resolves.toEqual({ shippingCost: 0 });
  expect(vi.getTimerCount()).toBe(0);
  await expect(
    requestShippingEstimate({} as ShippingDraft, 'test'),
  ).rejects.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  [0, 0],
  [0.01, 1],
  [0.29, 29],
  [1.01, 101],
  [15.99, 1599],
  [MAX_SHIPPING_COST_USD, MAX_SHIPPING_COST_USD * 100],
])('converts validated USD %s to safe exact cents %s', (dollars, cents) => {
  expect(shippingUsdCents(dollars)).toBe(cents);
  expect(shippingEstimateSchema.parse({ shippingCost: dollars })).toEqual({
    shippingCost: dollars,
  });
  expect(Math.round(dollars * 100)).toBe(cents);
  expect(cents / 100).toBe(dollars);
});
test.each([
  0.001,
  1.005,
  1.001,
  0.1 + 0.2,
  MAX_SHIPPING_COST_USD + 1,
  Number.MAX_SAFE_INTEGER,
  Infinity,
  NaN,
  -0.01,
])('rejects non-cent or unsafe USD amount %s', dollars => {
  expect(shippingUsdCents(dollars)).toBeUndefined();
  expect(
    shippingEstimateSchema.safeParse({ shippingCost: dollars }).success,
  ).toBe(false);
  expect(() =>
    parseShippingEstimate({ data: { totals: { deliveryCost: dollars } } }),
  ).toThrow();
});
test.each([
  '90071992547409.91',
  '9007199254740993.00',
  '70368744177664.01',
  '1.005',
])('rejects unsafe/lossy decimal %s', dollars => {
  expect(shippingUsdCents(dollars)).toBeUndefined();
  expect(() =>
    parseShippingEstimate({ data: { order: { deliveryCost: dollars } } }),
  ).toThrow();
});
test('preserves cent comparison across decimal string and numeric fields', () => {
  expect(
    parseShippingEstimate({
      data: { order: { deliveryCost: '0.29' }, totals: { deliveryCost: 0.29 } },
    }),
  ).toEqual({ shippingCost: 0.29 });
  expect(() =>
    parseShippingEstimate({
      data: { order: { deliveryCost: '0.29' }, totals: { deliveryCost: 0.3 } },
    }),
  ).toThrow();
});
