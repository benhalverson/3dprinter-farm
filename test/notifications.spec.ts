import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  deliverNotification,
  enqueueAdminFailure,
  enqueueOrderNotification,
} from '../src/lib/notifications';
import {
  isTrustedSlantEvent,
  recordSlantLifecycle,
  slantEventKey,
} from '../src/modules/slantLifecycle';
import type * as schema from '../src/db/schema';
import { scriptedDatabase } from './mocks/scriptedDatabase';
import { signedSlant, slantEnvelope } from './fixtures/slantWebhook';
import app from '../src/app';
import { mockEnv } from './mocks/env';

const boundary = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => boundary.db) }));
const send = vi.fn();
const env = {
  ORDER_EMAIL: { send },
  ORDER_ADMIN_EMAIL: 'admin@example.com',
  ORDER_NOTIFICATIONS_ENABLED: 'true',
};
const envelope = {
  id: 7,
  orderId: null,
  notificationType: 'admin_failure_alert',
  deliveryKey: 'stable-key',
  status: 'pending',
  senderEmail: 'Lulu Speedworks <noreply@luluspeedworks.com>',
  recipientEmail: 'admin@example.com',
  subject: 'Order alert',
  textContent: 'Review order #7',
  providerMessageId: null,
  updatedAt: new Date().toISOString(),
};
const owner = {
  id: 1,
  userId: 'owner',
  cartId: 'cart',
  source: 'online',
  fulfillmentType: 'slant',
  paymentStatus: 'paid',
  checkoutAttemptId: 'attempt',
  squarePaymentId: 'payment',
  squareOrderId: 'square-order',
  fulfillmentState: 'processed',
  status: 'processing',
  slantStatus: 'PROCESSING',
  slantPublicOrderId: 'slant-order',
  customerSnapshot: JSON.stringify({ email: 'customer@example.com' }),
};
const checkout = {
  id: 'attempt',
  ownerId: 'owner',
  cartId: 'cart',
  state: 'paid',
  squarePaymentId: 'payment',
  squareOrderId: 'square-order',
  customerEmail: 'customer@example.com',
};
function fixture(...responses: unknown[]) {
  const mock = scriptedDatabase(...responses);
  boundary.db = mock.db;
  return { ...mock, db: drizzle({} as D1Database) };
}
beforeEach(() => {
  send.mockReset().mockResolvedValue({ messageId: 'mock-ack' });
});

it('sends the saved envelope only after a successful mocked claim and records acknowledgement', async () => {
  const mock = fixture(
    envelope,
    [{ ...envelope, status: 'sending' }],
    undefined,
  );
  expect(await deliverNotification(mock.db, env, 7)).toEqual({
    id: 7,
    status: 'sent',
    providerMessageId: 'mock-ack',
  });
  expect(send).toHaveBeenCalledExactlyOnceWith({
    from: envelope.senderEmail,
    to: envelope.recipientEmail,
    subject: envelope.subject,
    text: envelope.textContent,
  });
  const writes = mock.calls
    .filter(call => call.method === 'set')
    .map(call => call.args[0]);
  expect(writes).toEqual([
    expect.objectContaining({
      status: 'sending',
      claimToken: expect.any(String),
    }),
    expect.objectContaining({ status: 'sent', providerMessageId: 'mock-ack' }),
  ]);
  expect(mock.replies).toEqual([]);
});
it.each([
  'sent',
  'sending',
  'unknown',
  'skipped',
])('does not resend a mocked %s attempt', async status => {
  const mock = fixture({ ...envelope, status });
  expect(await deliverNotification(mock.db, env, 7)).toMatchObject({ status });
  expect(send).not.toHaveBeenCalled();
});
it('does not send when another mocked claimant won', async () => {
  const mock = fixture(envelope, [], { ...envelope, status: 'sending' });
  expect(await deliverNotification(mock.db, env, 7)).toMatchObject({
    status: 'sending',
  });
  expect(send).not.toHaveBeenCalled();
});
it('records an ambiguous provider rejection without retrying', async () => {
  send.mockRejectedValue(new Error('private provider detail'));
  const mock = fixture(
    envelope,
    [{ ...envelope, status: 'sending' }],
    undefined,
  );
  expect(await deliverNotification(mock.db, env, 7)).toEqual({
    id: 7,
    status: 'unknown',
    providerMessageId: null,
  });
  expect(
    mock.calls.filter(call => call.method === 'set').at(-1)?.args[0],
  ).toMatchObject({
    status: 'unknown',
    errorMessage: 'notification_delivery_unknown',
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it('propagates a post-send database failure without a second send', async () => {
  const mock = fixture(
    envelope,
    [{ ...envelope, status: 'sending' }],
    new Error('controlled_ack_failure'),
  );
  await expect(deliverNotification(mock.db, env, 7)).rejects.toThrow(
    'controlled_ack_failure',
  );
  expect(send).toHaveBeenCalledTimes(1);
});
it.each([
  { subject: 'bad\r\nheader' },
  { recipientEmail: 'invalid' },
  { senderEmail: 'forged@example.com' },
  { textContent: '' },
])('rejects invalid saved envelopes %j before sending', async change => {
  const mock = fixture({ ...envelope, ...change }, undefined, {
    ...envelope,
    status: 'failed',
  });
  expect(await deliverNotification(mock.db, env, 7)).toMatchObject({
    status: 'failed',
  });
  expect(send).not.toHaveBeenCalled();
});
it('disabled notifications and legacy envelopes cause no writes or sends', async () => {
  for (const [row, settings] of [
    [envelope, { ...env, ORDER_NOTIFICATIONS_ENABLED: 'false' }],
    [{ ...envelope, deliveryKey: null }, env],
  ] as const) {
    const mock = fixture(row);
    await deliverNotification(mock.db, settings, 7);
    expect(mock.calls.some(call => call.method === 'update')).toBe(false);
  }
  expect(send).not.toHaveBeenCalled();
});
it('suppresses a confirmation when the mocked conditional update reports cancellation', async () => {
  const mock = fixture(
    { ...envelope, notificationType: 'order_confirmation', orderId: 1 },
    [{ ...envelope, status: 'skipped' }],
  );
  expect(await deliverNotification(mock.db, env, 7)).toMatchObject({
    status: 'skipped',
  });
  expect(send).not.toHaveBeenCalled();
});
it('reuses an existing delivery identity without inserting or sending', async () => {
  const mock = fixture(envelope);
  expect(await enqueueOrderNotification(mock.db, 1, 'confirmed')).toEqual(
    envelope,
  );
  expect(mock.calls.some(call => call.method === 'insert')).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
it('constructs a confirmation only from supplied verified payment and fulfillment facts', async () => {
  const mock = fixture(
    undefined,
    owner,
    checkout,
    { id: 1 },
    { id: 2 },
    undefined,
    envelope,
  );
  await enqueueOrderNotification(mock.db, 1, 'confirmed');
  const saved = mock.calls.find(call => call.method === 'values')?.args[0];
  expect(saved).toMatchObject({
    recipientEmail: 'customer@example.com',
    subject: 'Order #1 confirmed',
    source: 'square',
    deliveryKey: JSON.stringify([
      'order-email-v1',
      '1',
      'order_confirmation',
      'confirmed',
    ]),
  });
  expect(JSON.stringify(saved)).not.toContain('square-order');
  expect(send).not.toHaveBeenCalled();
});
it.each([
  { paymentStatus: 'pending' },
  { source: 'in_person' },
  { checkoutAttemptId: null },
])('rejects unverified order evidence %j', async change => {
  const mock = fixture(undefined, { ...owner, ...change });
  await expect(
    enqueueOrderNotification(mock.db, 1, 'confirmed'),
  ).rejects.toThrow('notification_square_unverified');
  expect(mock.calls.some(call => call.method === 'insert')).toBe(false);
});
it('rejects mismatched recipient evidence', async () => {
  const mock = fixture(
    undefined,
    owner,
    { ...checkout, customerEmail: 'other@example.com' },
    { id: 1 },
    { id: 2 },
  );
  await expect(
    enqueueOrderNotification(mock.db, 1, 'confirmed'),
  ).rejects.toThrow('notification_recipient_invalid');
});
it('creates a bounded admin alert with a stable identity', async () => {
  const mock = fixture(undefined, envelope);
  await enqueueAdminFailure(
    mock.db,
    env,
    'attempt-key',
    'fulfillment_failed',
    1,
  );
  expect(
    mock.calls.find(call => call.method === 'values')?.args[0],
  ).toMatchObject({
    recipientEmail: 'admin@example.com',
    notificationType: 'admin_failure_alert',
    textContent: expect.stringContaining('fulfillment_failed'),
  });
});
it.each([
  { rows: [] },
  { rows: [owner, owner] },
])('rejects absent or ambiguous mocked lifecycle ownership', async ({
  rows,
}) => {
  const mock = fixture(rows);
  expect(
    await recordSlantLifecycle(mock.db, {
      eventId: 'event',
      orderId: 'slant-order',
      status: 'SHIPPED',
    }),
  ).toMatchObject({ status: rows.length ? 409 : 404 });
  expect(mock.calls.some(call => call.method === 'update')).toBe(false);
});
it('does not accept fabricated lifecycle provenance', () => {
  const event = {
    source: 'slant3d',
    actor: 'slant3d',
    type: 'slant_status_changed',
    externalEventId: 'event',
    dedupeKey: slantEventKey(1, 'slant-order', 'event'),
    metadata: JSON.stringify({
      provenance: 'configured-secret-v1',
      slantOrderId: 'slant-order',
    }),
  } as typeof schema.orderEventsTable.$inferSelect;
  expect(
    isTrustedSlantEvent(event, owner as typeof schema.ordersTable.$inferSelect),
  ).toBe(true);
  expect(
    isTrustedSlantEvent(
      { ...event, actor: 'customer' },
      owner as typeof schema.ordersTable.$inferSelect,
    ),
  ).toBe(false);
});
it.each([
  'tampered',
  'stale',
  'future',
  'platform',
  'signature',
])('rejects %s webhook before database work', async fault => {
  const mock = fixture();
  const timestamp =
    Date.now() +
    (fault === 'stale' ? -600001 : fault === 'future' ? 600001 : 0);
  const body = {
    ...slantEnvelope({
      eventId: 'event',
      orderId: 'slant-order',
      status: 'SHIPPED',
    }),
    ...(fault === 'platform' ? { platform_id: 'another' } : {}),
  };
  const options = await signedSlant(body, 'test-secret', timestamp);
  if (fault === 'tampered') options.body = String(options.body) + ' ';
  if (fault === 'signature')
    options.headers = { ...options.headers, 'X-Webhook-Signature-256': 'bad' };
  const response = await app.request('/webhook/slant3d', options, {
    ...mockEnv(),
    SLANT_WEBHOOK_SECRET: 'test-secret',
    SLANT_PLATFORM_ID: 'test-platform-id',
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mock.calls).toEqual([]);
  expect(send).not.toHaveBeenCalled();
});

it('reuses trusted lifecycle evidence without another write', async () => {
  const event = {
    orderId: 1,
    nextStatus: 'SHIPPED',
    source: 'slant3d',
    actor: 'slant3d',
    type: 'slant_status_changed',
    externalEventId: 'event',
    dedupeKey: slantEventKey(1, 'slant-order', 'event'),
    metadata: JSON.stringify({
      provenance: 'configured-secret-v1',
      slantOrderId: 'slant-order',
    }),
  };
  const mock = fixture([owner], event);
  expect(
    await recordSlantLifecycle(mock.db, {
      eventId: 'event',
      orderId: 'slant-order',
      status: 'SHIPPED',
    }),
  ).toMatchObject({ status: 200, orderId: 1 });
  expect(
    mock.calls.some(call => ['insert', 'update'].includes(call.method)),
  ).toBe(false);
});
it('rejects conflicting lifecycle event identity', async () => {
  const mock = fixture([owner], { orderId: 2, nextStatus: 'DELIVERED' });
  expect(
    await recordSlantLifecycle(mock.db, {
      eventId: 'event',
      orderId: 'slant-order',
      status: 'SHIPPED',
    }),
  ).toMatchObject({ status: 409 });
  expect(mock.calls.some(call => call.method === 'update')).toBe(false);
});
it('does not regress an already delivered order', async () => {
  const mock = fixture([{ ...owner, slantStatus: 'DELIVERED' }], undefined);
  expect(
    await recordSlantLifecycle(mock.db, {
      eventId: 'event',
      orderId: 'slant-order',
      status: 'SHIPPED',
    }),
  ).toMatchObject({ status: 409, error: 'Invalid lifecycle transition' });
  expect(mock.calls.some(call => call.method === 'update')).toBe(false);
});
