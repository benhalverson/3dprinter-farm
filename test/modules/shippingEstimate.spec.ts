import { afterEach, expect, test, vi } from 'vitest';
import {
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
test('does not infer conversion or currency from unrelated aliases or item currency', () => {
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
