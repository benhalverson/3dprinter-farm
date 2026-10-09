import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, expect, test, vi } from 'vitest';
import { createPaidOrderFulfillment } from '../../src/modules/paidOrderFulfillment';
import { scriptedDatabase } from '../mocks/scriptedDatabase';
import { mockEnv } from '../mocks/env';

const order = { id: 1, paymentStatus: 'paid', fulfillmentType: 'slant', fulfillmentState: 'processed',
  status: 'processing', slantStatus: 'PROCESSING', slantPublicOrderId: 'slant-order',
  checkoutAttemptId: 'checkout', squarePaymentId: 'payment', shippedAt: null, deliveredAt: null, canceledAt: null };
function remote(status: string, overrides: Record<string, unknown> = {}) {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true, data: { order: {
    publicId: 'slant-order', metadata: { checkoutAttemptId: 'checkout', squarePaymentId: 'payment' }, status, ...overrides,
  } } }));
}
beforeEach(() => { vi.mocked(fetch).mockReset(); });

test.each(['SHIPPED', 'DELIVERED', 'CANCELED'])('refreshes already processed orders from correlated %s evidence with a guarded update', async status => {
  remote(status);
  // Finalization reads a concurrent terminal/missing order here; no cart storage is simulated.
  const db = scriptedDatabase([order], [], []);
  await createPaidOrderFulfillment({ db: db.db, env: mockEnv() }).reconcilePaidOrder(1, undefined, true);
  const set = db.calls.find(call => call.method === 'set')!.args[0];
  expect(set).toMatchObject({ slantStatus: status, status: status.toLowerCase() });
  const updateIndex = db.calls.findIndex(call => call.method === 'update');
  const where = db.calls.slice(updateIndex).find(call => call.method === 'where')!.args[0] as SQL;
  const query = new SQLiteSyncDialect().sqlToQuery(where);
  expect(query.sql).toContain('"ordersTable"."payment_status" = ?');
  expect(query.sql).toContain('"ordersTable"."fulfillment_state" = ?');
  expect(query.sql).toContain('"ordersTable"."slant_status" = ?');
  expect(query.sql).toContain('"ordersTable"."status" = ?');
  expect(query.params).toEqual([1, 'paid', 'processed', 'slant-order', 'PROCESSING', 'processing']);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/orders/slant-order'), expect.objectContaining({ method: 'GET' }));
  expect(db.replies).toHaveLength(0);
});

test.each([
  ['SHIPPED', 'PROCESSING'], ['DELIVERED', 'SHIPPED'], ['CANCELED', 'PROCESSING'], ['SHIPPED', 'CANCELED'],
])('does not regress %s to %s', async (prior, next) => {
  remote(next);
  const db = scriptedDatabase([{ ...order, slantStatus: prior, status: prior.toLowerCase() }], []);
  await createPaidOrderFulfillment({ db: db.db, env: mockEnv() }).reconcilePaidOrder(1, undefined, true);
  expect(db.calls.some(call => call.method === 'update')).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  { publicId: 'another-order' },
  { metadata: { checkoutAttemptId: 'other-checkout', squarePaymentId: 'payment' } },
  { metadata: { checkoutAttemptId: 'checkout', squarePaymentId: 'other-payment' } },
])('rejects mismatched provider evidence before writes: %j', async overrides => {
  remote('SHIPPED', overrides);
  const db = scriptedDatabase([order]);
  await expect(createPaidOrderFulfillment({ db: db.db, env: mockEnv() }).reconcilePaidOrder(1, undefined, true)).rejects.toThrow('Slant association mismatch');
  expect(db.calls.some(call => call.method === 'update')).toBe(false);
});

test('unavailable provider performs no writes or manufacturing calls', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
  const db = scriptedDatabase([order]);
  await expect(createPaidOrderFulfillment({ db: db.db, env: mockEnv() }).reconcilePaidOrder(1, undefined, true)).rejects.toThrow();
  expect(db.calls.some(call => call.method === 'update')).toBe(false);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({ method: 'GET' }));
});

test('a missing Slant identity never triggers provider search or creation', async () => {
  const db = scriptedDatabase([{ ...order, fulfillmentState: 'draft_unknown', slantPublicOrderId: null }]);
  await createPaidOrderFulfillment({ db: db.db, env: mockEnv() }).reconcilePaidOrder(1, undefined, true);
  expect(fetch).not.toHaveBeenCalled();
  expect(db.calls.some(call => call.method === 'update')).toBe(false);
});

test('a terminal local state still protects against stale Slant status fields', async () => {
  remote('PROCESSING');
  const db = scriptedDatabase([{ ...order, status: 'delivered' }], []);
  await createPaidOrderFulfillment({ db: db.db, env: mockEnv() }).reconcilePaidOrder(1, undefined, true);
  expect(db.calls.some(call => call.method === 'update')).toBe(false);
});
