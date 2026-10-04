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
  0,
  15.99,
  '15.99',
  '0',
  ' 15.99 ',
])('preserves nonnegative raw amount %s', raw => {
  expect(parseShippingEstimate({ shippingCost: raw })).toEqual({
    shippingCost: Number(raw),
  });
});
test.each([
  null,
  true,
  {},
  [],
  '',
  ' ',
  '-1',
  '0x10',
  '1e2',
  'NaN',
  'Infinity',
  -1,
  Infinity,
  NaN,
])('rejects invalid raw amount %s', raw => {
  expect(() => parseShippingEstimate({ shippingCost: raw })).toThrow();
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
test('rejects conflicting aliases rather than guessing an amount', () => {
  expect(() =>
    parseShippingEstimate({
      shippingCost: 1,
      data: { order: { deliveryCost: 100 } },
    }),
  ).toThrow();
  expect(
    parseShippingEstimate({
      shippingCost: 1,
      data: { order: { deliveryCost: '1' } },
    }),
  ).toEqual({ shippingCost: 1 });
});
test('does not accept inherited amount fields', () => {
  expect(() =>
    parseShippingEstimate(Object.create({ shippingCost: 10 })),
  ).toThrow();
});
test('retains historical compatibility paths without unit conversion', () => {
  for (const key of [
    'shippingCost',
    'shipping_cost',
    'estimatedShippingCost',
    'deliveryCost',
  ]) {
    expect(parseShippingEstimate({ [key]: 1 })).toEqual({ shippingCost: 1 });
    expect(parseShippingEstimate({ data: { [key]: '1' } })).toEqual({
      shippingCost: 1,
    });
  }
  for (const key of ['shipping', 'estimate', 'estimatedCosts']) {
    for (const field of ['shippingCost', 'shipping_cost']) {
      expect(
        parseShippingEstimate({ data: { [key]: { [field]: '1' } } }),
      ).toEqual({ shippingCost: 1 });
    }
  }
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
      .mockResolvedValueOnce(Response.json({ shippingCost: 0 }))
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
