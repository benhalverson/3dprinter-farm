import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, expect, test, vi } from 'vitest';
import app from '../../src/app';
import { orderReconciliationAttemptsTable, ordersTable } from '../../src/db/schema';
import { mockBetterAuth } from '../mocks/auth';
import { mockEnv } from '../mocks/env';
import { scriptedDatabase } from '../mocks/scriptedDatabase';

const { reconcile, notifications } = vi.hoisted(() => ({ reconcile: vi.fn(), notifications: vi.fn() }));
vi.mock('../../src/modules/paidOrderFulfillment', () => ({ createPaidOrderFulfillment: () => ({ reconcilePaidOrder: reconcile }) }));
vi.mock('../../src/lib/notifications', async original => ({
  ...await original<typeof import('../../src/lib/notifications')>(),
  tryReconcileSquareNotifications: notifications,
}));
const line = { cartItemId: 8, productId: 1, skuNumber: 'SKU', name: 'Part', quantity: 2,
  filamentType: 'PLA', filamentId: '20000000-0000-4000-8000-000000000001', color: 'Black',
  publicFileServiceId: 'file', unitAmountCents: 100, totalAmountCents: 200 };
const order = { id: 1, orderNumber: 'ORDER-1', userId: 'buyer', cartId: null,
  fulfillmentType: 'slant', squarePaymentId: 'payment', squareOrderId: 'square-order',
  slantPublicOrderId: 'slant-order', checkoutAttemptId: 'checkout', paymentStatus: 'paid',
  fulfillmentState: 'processed', status: 'processing', slantStatus: 'PROCESSING',
  itemSnapshot: JSON.stringify([line]), customerSnapshot: '{"email":"buyer@example.com"}' };
const member = { role: 'admin', organizationId: 'org_shared_catalog', userId: 'admin' };
const request = (body: object = {}) => app.request('/admin/orders/1/reconcile', {
  method: 'POST', headers: { cookie: 'fixture', 'content-type': 'application/json' },
  body: JSON.stringify(body),
}, mockEnv());
/**
 * Install ordered Drizzle replies for the real admin route while fulfillment and
 * notifications remain mocked. This fixture observes audit calls and failures;
 * it does not execute SQL or model concurrent database writes.
 */
function database(...replies: unknown[]) {
  const fixture = scriptedDatabase(...replies);
  vi.mocked(drizzle).mockReturnValue(fixture.db);
  return fixture;
}
function writes(fixture: ReturnType<typeof database>, method: string) {
  return fixture.calls.filter(call => call.method === method).map(call => call.args[0]);
}
beforeEach(() => {
  vi.clearAllMocks();
  reconcile.mockReset().mockResolvedValue(undefined);
  notifications.mockResolvedValue(undefined);
  mockBetterAuth.getSession.mockResolvedValue({ user: { id: 'admin' }, session: {} } as never);
});

test('persists a no-op attempt before invoking read-only Square fulfillment recovery', async () => {
  const db = database(member, order, [{ id: 9 }], [order], []);
  expect((await request()).status).toBe(200);
  expect(reconcile).toHaveBeenCalledWith(1, undefined, true);
  expect(writes(db, 'values')).toContainEqual(expect.objectContaining({ resultStatus: 'running', orderId: 1 }));
  expect(writes(db, 'set')).toContainEqual(expect.objectContaining({ resultStatus: 'no_action', errorMessage: null }));
  expect(db.replies).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

test('reports a paid order with an unknown draft and no Slant ID without retrying manufacture', async () => {
  const pending = { ...order, fulfillmentState: 'draft_unknown', slantPublicOrderId: null };
  const db = database(member, pending, [{ id: 9 }], [pending], []);
  const response = await request();
  expect(await response.json()).toMatchObject({ resultStatus: 'draft_unknown', reconciliationStatus: 'reported',
    detectedIssues: ['missing_slant_order_id', 'paid_without_fulfillment', 'fulfillment_outcome_unknown'],
    actionsTaken: [], recommendedAction: expect.stringContaining('do not resubmit') });
  expect(writes(db, 'set')).toContainEqual(expect.objectContaining({ resultStatus: 'reported' }));
});

test('reports missing snapshots without attempting recovery or disclosing provider data', async () => {
  const db = database(member, { ...order, itemSnapshot: null, customerSnapshot: null }, [{ id: 9 }], []);
  expect(await (await request()).json()).toMatchObject({ reconciliationStatus: 'reported',
    detectedIssues: ['missing_or_invalid_item_snapshot', 'missing_customer_snapshot'] });
  expect(reconcile).not.toHaveBeenCalled();
  expect(writes(db, 'set')).toHaveLength(1);
});

test('records observed lifecycle recovery and preserves the existing fulfillment result field', async () => {
  const db = database(member, order, [{ id: 9 }], [{ ...order, status: 'shipped', slantStatus: 'SHIPPED' }], []);
  expect(await (await request()).json()).toMatchObject({ resultStatus: 'processed', reconciliationStatus: 'recovered',
    detectedIssues: ['local_status_stale'], actionsTaken: ['updated_local_status'] });
  expect(writes(db, 'set')).toContainEqual(expect.objectContaining({ actionsTaken: '["updated_local_status"]' }));
});

test('persists a sanitized failure and returns 502 when recovery fails', async () => {
  reconcile.mockRejectedValue(new Error('private upstream payload and credential'));
  const db = database(member, order, [{ id: 9 }], []);
  const response = await request();
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('credential');
  expect(writes(db, 'set')).toContainEqual(expect.objectContaining({ resultStatus: 'failed',
    detectedIssueType: '["reconciliation_unavailable"]', errorMessage: expect.not.stringContaining('credential') }));
});

test('audits in-person no-op without Slant or customer snapshot requirements', async () => {
  const db = database(member, { ...order, fulfillmentType: 'in_person', fulfillmentState: 'handed_over',
    slantPublicOrderId: null, customerSnapshot: null }, [{ id: 9 }], []);
  expect(await (await request()).json()).toMatchObject({ resultStatus: 'handed_over', detectedIssues: [], reconciliationStatus: 'no_action' });
  expect(reconcile).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(db.replies).toHaveLength(0);
});

test('compares exact paid cart lines and reports their cleanup without claiming new additions', async () => {
  const withCart = { ...order, cartId: 'cart' };
  const paidLine = { ...line, id: 8, userId: 'buyer' };
  const newLine = { ...paidLine, id: 9 };
  const db = database(member, withCart, [{ id: 9 }], [paidLine, newLine], [withCart], [newLine], []);
  expect(await (await request()).json()).toMatchObject({ reconciliationStatus: 'recovered',
    detectedIssues: ['cart_not_cleared_after_fulfillment'], actionsTaken: ['cleared_paid_cart_lines'] });
  expect(writes(db, 'delete')).toEqual([]);
  expect(db.replies).toHaveLength(0);
});

test('does not run recovery if the audit reservation cannot be persisted', async () => {
  database(member, order, new Error('database unavailable'));
  expect((await request()).status).toBe(500);
  expect(reconcile).not.toHaveBeenCalled();
});

test.each([null, { role: 'member' }])('rejects non-staff before audit writes: %j', async membership => {
  const db = database(membership);
  expect((await request()).status).toBe(403);
  expect(writes(db, 'insert')).toEqual([]);
  expect(reconcile).not.toHaveBeenCalled();
});

test('persists attempts only to the existing reconciliation table', async () => {
  const db = database(member, order, [{ id: 9 }], [order], []);
  await request();
  expect(writes(db, 'insert')).toEqual([orderReconciliationAttemptsTable]);
  expect(writes(db, 'update')).not.toContain(ordersTable);
});
