import { signedSlant, slantEnvelope } from './fixtures/slantWebhook';
import { applyD1Migrations, env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import {
  recordSlantLifecycle,
  slantEventKey,
} from '../src/modules/slantLifecycle';
import * as schema from '../src/db/schema';
import { mockBetterAuth } from './mocks/auth';

vi.unmock('drizzle-orm/d1');

import { orderNotificationAttemptsTable as attempts } from '../src/db/schema';
import {
  deliverNotification,
  enqueueAdminFailure,
  enqueueOrderNotification,
  type NotificationEnv,
  reconcileSquareNotifications,
} from '../src/lib/notifications';

const { drizzle } =
  await vi.importActual<typeof import('drizzle-orm/d1')>('drizzle-orm/d1');
const bindings = env as unknown as {
  NOTIFICATIONS_TEST_DB: D1Database;
  NOTIFICATIONS_TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = drizzle(bindings.NOTIFICATIONS_TEST_DB, { schema });
const send = vi.fn().mockResolvedValue({ messageId: 'cloudflare-message' });
const mail: NotificationEnv = {
  ORDER_EMAIL: { send },
  ORDER_ADMIN_EMAIL: 'admin@example.com',
  ORDER_NOTIFICATIONS_ENABLED: 'true',
};

beforeAll(async () => {
  await applyD1Migrations(
    bindings.NOTIFICATIONS_TEST_DB,
    bindings.NOTIFICATIONS_TEST_MIGRATIONS,
  );
});
beforeEach(async () => {
  await db.delete(attempts);
  await db.delete(schema.ordersTable);
  await db.delete(schema.checkoutAttempts);
  await db.delete(schema.checkoutQuotes);
  await db.delete(schema.memberTable);
  mockBetterAuth.getSession.mockResolvedValue(null);
  send.mockReset().mockResolvedValue({ messageId: 'cloudflare-message' });
});

/** Create a locally owned processed order without invoking payment or fulfillment providers. */
async function order() {
  await db
    .insert(schema.users)
    .values({ id: 'test-owner', email: 'owner@example.com', name: 'Owner' })
    .onConflictDoNothing();
  const identity = crypto.randomUUID();
  await db.insert(schema.checkoutQuotes).values({
    id: identity,
    ownerId: 'test-owner',
    cartId: identity,
    inputHash: 'hash',
    encryptedSnapshot: 'fixture',
    createdAt: 1,
    expiresAt: 2,
    consumedAttemptId: identity,
  });
  await db.insert(schema.checkoutAttempts).values({
    id: identity,
    ownerId: 'test-owner',
    cartId: identity,
    quoteId: identity,
    requestKey: identity,
    snapshot: '{}',
    customerEmail: 'customer@example.com',
    merchantId: 'merchant',
    locationId: 'location',
    state: 'paid',
    squarePaymentId: identity,
    squareOrderId: identity,
    createdAt: 1,
  });
  const [row] = await db
    .insert(schema.ordersTable)
    .values({
      shipToName: 'Customer',
      shipToStreet1: '1 Test Street',
      shipToCity: 'Test',
      shipToState: 'CA',
      shipToZip: '90000',
      shipToCountryISO: 'US',
      userId: 'test-owner',
      filename: 'part',
      fileURL: 'private-print',
      orderNumber: `PRIVATE-${identity}`,
      cartId: identity,
      checkoutAttemptId: identity,
      squareOrderId: identity,
      squarePaymentId: identity,
      source: 'online',
      fulfillmentType: 'slant',
      paymentStatus: 'paid',
      fulfillmentState: 'processed',
      customerSnapshot: JSON.stringify({ email: 'customer@example.com' }),
      customerEmail: 'customer@example.com',
      status: 'processing',
      slantStatus: 'PROCESSING',
      slantPublicOrderId: identity,
    })
    .returning();
  await db.insert(schema.orderEventsTable).values([
    {
      orderId: row.id,
      type: 'square_payment_verified',
      dedupeKey: `square-paid:${identity}`,
      source: 'square',
      actor: 'square',
      externalEventId: identity,
      nextStatus: 'paid',
    },
    {
      orderId: row.id,
      type: 'square_fulfillment_processed',
      dedupeKey: `square-fulfilled:${identity}`,
      source: 'square',
      actor: 'square',
      externalEventId: identity,
      nextStatus: 'PROCESSING',
    },
  ]);
  return row;
}

/** Load a persisted attempt for durability assertions. */
async function attempt(id: number) {
  return db.select().from(attempts).where(eq(attempts.id, id)).get();
}

describe('Cloudflare order notifications with real local D1', () => {
  it('concurrent enqueue and send have one durable winner', async () => {
    const row = await order();
    const queued = await Promise.all(
      Array.from({ length: 8 }, () =>
        enqueueOrderNotification(db, row.id, 'confirmed'),
      ),
    );
    expect(new Set(queued.map(item => item.id)).size).toBe(1);
    await Promise.all(
      queued.map(item => deliverNotification(db, mail, item.id)),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(await attempt(queued[0].id)).toMatchObject({
      status: 'sent',
      providerMessageId: 'cloudflare-message',
    });
    expect(send).toHaveBeenCalledWith({
      from: 'Lulu Speedworks <noreply@luluspeedworks.com>',
      to: 'customer@example.com',
      subject: `Order #${row.id} confirmed`,
      text: `Thank you for your order. Order #${row.id} was confirmed for fulfillment.`,
    });
  });

  it('pre-provider configuration failure retries the original recipient and content', async () => {
    const row = await order();
    const queued = await enqueueOrderNotification(db, row.id, 'confirmed');
    expect(
      await deliverNotification(
        db,
        { ORDER_NOTIFICATIONS_ENABLED: 'true' },
        queued.id,
      ),
    ).toMatchObject({
      status: 'failed',
    });
    expect(send).not.toHaveBeenCalled();
    await db
      .update(schema.ordersTable)
      .set({ customerEmail: 'changed@example.com', slantStatus: 'SHIPPED' })
      .where(eq(schema.ordersTable.id, row.id));
    await enqueueOrderNotification(db, row.id, 'confirmed');
    await deliverNotification(db, mail, queued.id);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: 'customer@example.com',
      subject: queued.subject,
      text: queued.textContent,
    });
  });

  it('provider exceptions are ambiguous, redacted, and never automatically resent', async () => {
    const row = await order();
    const queued = await enqueueOrderNotification(db, row.id, 'confirmed');
    send.mockRejectedValueOnce(
      new Error('secret-token customer@example.com <script>'),
    );
    expect(await deliverNotification(db, mail, queued.id)).toMatchObject({
      status: 'unknown',
    });
    expect(await deliverNotification(db, mail, queued.id)).toMatchObject({
      status: 'unknown',
    });
    expect(send).toHaveBeenCalledTimes(2); // customer + one redacted admin alert
    const stored = await db.select().from(attempts);
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain('secret-token');
    expect(send.mock.calls[1][0]).toMatchObject({ to: 'admin@example.com' });
    expect(JSON.stringify(send.mock.calls[1])).not.toContain(
      'customer@example.com',
    );
  });

  it('missing acceptance ID remains unknown and a sending claim cannot be reclaimed', async () => {
    const queued = await enqueueAdminFailure(
      db,
      mail,
      'payment-1',
      'fulfillment_failed',
    );
    send.mockResolvedValueOnce({});
    await deliverNotification(db, mail, queued.id);
    expect(await attempt(queued.id)).toMatchObject({ status: 'unknown' });
    await db
      .update(attempts)
      .set({ status: 'sending' })
      .where(eq(attempts.id, queued.id));
    await deliverNotification(db, mail, queued.id);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('an alert survives missing admin configuration and pins the first valid address', async () => {
    const queued = await enqueueAdminFailure(
      db,
      {},
      'payment-1',
      'fulfillment_failed',
    );
    await deliverNotification(
      db,
      { ORDER_NOTIFICATIONS_ENABLED: 'true' },
      queued.id,
    );
    expect(await attempt(queued.id)).toMatchObject({
      status: 'failed',
      recipientEmail: '',
    });
    await deliverNotification(
      db,
      {
        ORDER_ADMIN_EMAIL: 'first@example.com',
        ORDER_NOTIFICATIONS_ENABLED: 'true',
      },
      queued.id,
    );
    await deliverNotification(
      db,
      { ...mail, ORDER_ADMIN_EMAIL: 'second@example.com' },
      queued.id,
    );
    expect(send.mock.calls[0][0]).toMatchObject({ to: 'first@example.com' });
  });

  it.each([
    'unknown-write',
    'alert-insert',
    'acceptance-write',
  ])('recovers admin alerts after %s failure without customer redelivery', async fault => {
    const row = await order();
    const queued = await enqueueOrderNotification(db, row.id, 'confirmed');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    send.mockImplementationOnce(async () => {
      if (fault === 'alert-insert') {
        vi.spyOn(db, 'insert').mockImplementationOnce(() => {
          throw new Error('db outage');
        });
      } else {
        vi.spyOn(db, 'update').mockImplementationOnce(() => {
          throw new Error('db outage');
        });
      }
      if (fault === 'acceptance-write')
        return { messageId: 'accepted-before-outage' };
      throw new Error('ambiguous provider timeout');
    });
    if (fault === 'alert-insert') {
      expect(await deliverNotification(db, mail, queued.id)).toMatchObject({
        status: 'unknown',
      });
    } else {
      await expect(deliverNotification(db, mail, queued.id)).rejects.toThrow(
        'db outage',
      );
    }
    // Fault hooks have been consumed; age a crashed claim past the grace period.
    await db
      .update(attempts)
      .set({ updatedAt: new Date(Date.now() - 700_000).toISOString() })
      .where(eq(attempts.id, queued.id));
    await deliverNotification(db, mail, queued.id);
    await deliverNotification(db, mail, queued.id);
    expect(send).toHaveBeenCalledTimes(2); // one customer attempt and one alert
    expect(send.mock.calls[1][0]).toMatchObject({ to: 'admin@example.com' });
    expect(
      (await db.select().from(attempts)).filter(
        item => item.notificationType === 'admin_failure_alert',
      ),
    ).toHaveLength(1);
    errorLog.mockRestore();
  });

  it('legacy rows and invalid/stale order recipients cannot trigger emails', async () => {
    const [legacy] = await db
      .insert(attempts)
      .values({
        notificationType: 'order_confirmation',
        recipientEmail: 'legacy@example.com',
        status: 'failed',
        source: 'legacy',
        idempotencyKey: 'legacy',
      })
      .returning();
    await deliverNotification(db, mail, legacy.id);
    const row = await order();
    await expect(
      enqueueOrderNotification(db, row.id, 'shipped'),
    ).rejects.toThrow('notification_lifecycle_unverified');
    await db
      .update(schema.ordersTable)
      .set({
        customerSnapshot: JSON.stringify({ email: 'mismatch@example.com' }),
      })
      .where(eq(schema.ordersTable.id, row.id));
    await expect(
      enqueueOrderNotification(db, row.id, 'confirmed'),
    ).rejects.toThrow('notification_recipient_invalid');
    expect(send).not.toHaveBeenCalled();
  });
});

/** Use the real organization authorization with a mocked authenticated session. */
async function session(role: string) {
  await db
    .insert(schema.users)
    .values({
      id: 'admin-user',
      email: 'operator@example.com',
      name: 'Operator',
    })
    .onConflictDoNothing();
  await db.insert(schema.organizationTable).values({
    id: 'org_shared_catalog', name: 'Staff', slug: 'staff', createdAt: new Date(),
  }).onConflictDoNothing();
  await db.insert(schema.memberTable).values({
    id: 'staff-operator', organizationId: 'org_shared_catalog', userId: 'admin-user',
    role: role === 'user' ? 'member' : role, createdAt: new Date(),
  }).onConflictDoUpdate({ target: schema.memberTable.id, set: { role: role === 'user' ? 'member' : role } });
  mockBetterAuth.getSession.mockResolvedValue({
    session: { id: 'session', expiresAt: new Date(Date.now() + 60_000) },
    user: {
      id: 'admin-user',
      email: 'operator@example.com',
      name: 'Operator',
      role,
    },
  });
}

/** Invoke the mounted production router with only local storage and fake email. */
function request(path: string, method = 'GET', body?: string) {
  return app.request(
    path,
    {
      method,
      body,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
    },
    { DB: bindings.NOTIFICATIONS_TEST_DB, ...mail },
  );
}

describe('notification administration authorization and safe responses', () => {
  it.each([
    '/notifications/order/1',
    '/notifications/failed',
    '/notifications/resend/1',
    '/notifications/order/1/reconcile',
  ])('requires authentication and privileged organization membership: %s', async path => {
    const method =
      path.includes('/resend/') || path.endsWith('/reconcile') ? 'POST' : 'GET';
    expect((await request(path, method)).status).toBe(401);
    await session('user');
    const response = await request(path, method);
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores injected retry recipients and does not expose message envelopes', async () => {
    await session('admin');
    const row = await order();
    const queued = await enqueueOrderNotification(db, row.id, 'confirmed');
    const response = await request(
      `/notifications/resend/${queued.id}`,
      'POST',
      JSON.stringify({
        recipientEmail: 'attacker@example.com',
        subject: 'evil',
      }),
    );
    expect(response.status).toBe(200);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: 'customer@example.com',
      subject: queued.subject,
    });
    const listing = await request(`/notifications/order/${row.id}`);
    expect(listing.status).toBe(200);
    const text = await listing.text();
    expect(text).not.toContain('customer@example.com');
    expect(text).not.toContain('Thank you');
    expect(listing.headers.get('cache-control')).toContain('no-store');
  });

  it('rejects malformed IDs and forbids resending uncertain outcomes', async () => {
    await session('owner');
    expect((await request('/notifications/order/1evil')).status).toBe(400);
    expect(
      (await request('/notifications/resend/9007199254740993', 'POST')).status,
    ).toBe(400);
    expect((await request('/notifications/resend/999', 'POST')).status).toBe(
      404,
    );
    const queued = await enqueueAdminFailure(
      db,
      mail,
      'payment1',
      'fulfillment_failed',
    );
    await db
      .update(attempts)
      .set({ status: 'unknown' })
      .where(eq(attempts.id, queued.id));
    expect(
      (await request(`/notifications/resend/${queued.id}`, 'POST')).status,
    ).toBe(409);
    const failed = await request('/notifications/failed');
    expect(await failed.json()).toMatchObject({
      notifications: [{ id: queued.id, status: 'unknown' }],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('redacts mounted database failures before logging or returning them', async () => {
    await session('admin');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = 'secret-token customer@example.com private-message';
    const response = await app.request(
      '/notifications/failed',
      {},
      {
        DB: {
          prepare() {
            throw new Error(secret);
          },
        },
        ...mail,
      },
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(log).toHaveBeenCalledWith('notification.request_failed');
    log.mockRestore();
  });

  it('publishes all notification routes in the existing OpenAPI document', async () => {
    const response = await request('/open-api');
    expect(response.status).toBe(200);
    const spec = (await response.json()) as { paths: Record<string, unknown> };
    for (const path of [
      '/notifications/order/{orderId}',
      '/notifications/failed',
      '/notifications/resend/{id}',
      '/notifications/order/{orderId}/reconcile',
    ])
      expect(Object.keys(spec.paths)).toContain(path);
  });
});

describe('Square persisted-evidence notification integration', () => {
  it('queues but never sends by default, including the manual retry path', async () => {
    const row = await order();
    const outcome = await reconcileSquareNotifications(db, {}, row.id);
    expect(outcome).toMatchObject({
      verified: true,
      notifications: [{ status: 'disabled' }],
    });
    const queued = await db.select().from(attempts);
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe('pending');
    await deliverNotification(
      db,
      { ...mail, ORDER_NOTIFICATIONS_ENABLED: 'false' },
      queued[0].id,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    'SHIPPED',
    'DELIVERED',
  ])('recovers confirmed Square evidence after lifecycle advances to %s', async slantStatus => {
    const row = await order();
    await db
      .update(schema.ordersTable)
      .set({ slantStatus, customerEmail: 'mutable@example.com' })
      .where(eq(schema.ordersTable.id, row.id));
    await reconcileSquareNotifications(db, mail, row.id);
    await reconcileSquareNotifications(db, mail, row.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: 'customer@example.com' });
  });

  it.each([
    'payment-event',
    'fulfillment-event',
    'payment-identity',
    'checkout-owner',
    'snapshot-email',
    'unpaid',
  ])('refuses missing/mismatched %s proof', async fault => {
    const row = await order();
    if (fault === 'payment-event' || fault === 'fulfillment-event') {
      await db
        .delete(schema.orderEventsTable)
        .where(
          eq(
            schema.orderEventsTable.type,
            fault === 'payment-event'
              ? 'square_payment_verified'
              : 'square_fulfillment_processed',
          ),
        );
    } else if (fault === 'payment-identity') {
      await db
        .update(schema.ordersTable)
        .set({ squarePaymentId: 'wrong' })
        .where(eq(schema.ordersTable.id, row.id));
    } else if (fault === 'checkout-owner') {
      await db
        .insert(schema.users)
        .values({
          id: 'other-owner',
          email: 'other@example.com',
          name: 'Other',
        })
        .onConflictDoNothing();
      await db
        .update(schema.ordersTable)
        .set({ userId: 'other-owner' })
        .where(eq(schema.ordersTable.id, row.id));
    } else if (fault === 'snapshot-email') {
      await db
        .update(schema.ordersTable)
        .set({
          customerSnapshot: JSON.stringify({ email: 'attacker@example.com' }),
        })
        .where(eq(schema.ordersTable.id, row.id));
    } else {
      await db
        .update(schema.ordersTable)
        .set({ paymentStatus: 'pending' })
        .where(eq(schema.ordersTable.id, row.id));
    }
    await expect(
      enqueueOrderNotification(db, row.id, 'confirmed'),
    ).rejects.toThrow();
    expect(await db.select().from(attempts)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('alerts paid fulfillment failures once, then recovers the confirmation independently', async () => {
    const row = await order();
    await db
      .update(schema.ordersTable)
      .set({
        status: 'paid_fulfillment_failed',
        fulfillmentState: 'process_unknown',
      })
      .where(eq(schema.ordersTable.id, row.id));
    await reconcileSquareNotifications(db, mail, row.id);
    await reconcileSquareNotifications(db, mail, row.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: 'admin@example.com' });
    await db
      .update(schema.ordersTable)
      .set({ status: 'processing', fulfillmentState: 'processed' })
      .where(eq(schema.ordersTable.id, row.id));
    await reconcileSquareNotifications(db, mail, row.id);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({ to: 'customer@example.com' });
  });

  it('admin recovery ignores supplied event/recipient data and requires stored payment authority', async () => {
    await session('admin');
    const row = await order();
    const response = await request(
      `/notifications/order/${row.id}/reconcile`,
      'POST',
      JSON.stringify({
        email: 'attacker@example.com',
        event: 'square_fulfillment_processed',
      }),
    );
    expect(response.status).toBe(200);
    expect(send.mock.calls[0][0]).toMatchObject({ to: 'customer@example.com' });
    expect(
      (await request('/notifications/order/99999/reconcile', 'POST')).status,
    ).toBe(409);
  });

  it('does not turn historical Slant rows or canceled orders into customer emails', async () => {
    const row = await order();
    await db
      .update(schema.ordersTable)
      .set({ status: 'canceled', slantStatus: 'CANCELED' })
      .where(eq(schema.ordersTable.id, row.id));
    await db.insert(schema.orderEventsTable).values({
      orderId: row.id,
      type: 'slant_status_changed',
      source: 'slant3d',
      nextStatus: 'SHIPPED',
    });
    await reconcileSquareNotifications(db, mail, row.id);
    await expect(
      enqueueOrderNotification(db, row.id, 'shipped'),
    ).rejects.toThrow('notification_lifecycle_unverified');
    expect(send).not.toHaveBeenCalled();
  });
});

it.each([
  'reconcile',
  'manual',
])('suppresses queued confirmation after cancellation via %s without reclaiming ambiguity', async path => {
  const row = await order();
  await reconcileSquareNotifications(db, {}, row.id);
  const [queued] = await db.select().from(attempts);
  await db
    .update(schema.ordersTable)
    .set({ status: 'canceled', slantStatus: 'CANCELED' })
    .where(eq(schema.ordersTable.id, row.id));
  if (path === 'reconcile')
    await reconcileSquareNotifications(db, mail, row.id);
  else {
    await session('admin');
    expect(
      (await request(`/notifications/resend/${queued.id}`, 'POST')).status,
    ).toBe(409);
  }
  expect(await attempt(queued.id)).toMatchObject({ status: 'skipped' });
  expect(send).not.toHaveBeenCalled();
  await db
    .update(attempts)
    .set({ status: 'sending' })
    .where(eq(attempts.id, queued.id));
  await deliverNotification(db, mail, queued.id);
  expect(await attempt(queued.id)).toMatchObject({ status: 'sending' });
  expect(send).not.toHaveBeenCalled();
});

/** Invoke the authenticated lifecycle producer with local D1 and a mocked mail binding. */
async function webhook(
  body: unknown,
  secret: string | null = 'test-secret',
  enabled = false,
) {
  return app.request(
    '/webhook/slant3d',
    await signedSlant(slantEnvelope(body), secret),
    {
      DB: bindings.NOTIFICATIONS_TEST_DB,
      ...mail,
      ORDER_NOTIFICATIONS_ENABLED: enabled ? 'true' : 'false',
      SLANT_WEBHOOK_SECRET: 'test-secret',
      SLANT_PLATFORM_ID: 'test-platform-id',
    },
  );
}

/** Read current manufacturing/payment state after an event. */
async function currentOrder(id: number) {
  return db
    .select()
    .from(schema.ordersTable)
    .where(eq(schema.ordersTable.id, id))
    .get();
}

describe('authenticated Slant lifecycle and notification recovery', () => {
  it('rejects missing/wrong secrets, absent IDs, unknown and ambiguous mappings', async () => {
    const row = await order();
    const event = {
      eventId: 'event',
      orderId: row.slantPublicOrderId,
      status: 'SHIPPED',
    };
    expect((await webhook(event, null)).status).toBe(401);
    expect((await webhook(event, 'wrong')).status).toBe(401);
    expect((await webhook({ ...event, eventId: '' })).status).toBe(422);
    expect((await webhook({ ...event, orderId: undefined })).status).toBe(422);
    expect((await webhook({ ...event, orderId: 'unknown' })).status).toBe(404);
    const second = await order();
    await db
      .update(schema.ordersTable)
      .set({ slantPublicOrderId: row.slantPublicOrderId })
      .where(eq(schema.ordersTable.id, second.id));
    expect((await webhook(event)).status).toBe(409);
    expect((await currentOrder(row.id))?.slantStatus).toBe('PROCESSING');
    expect(send).not.toHaveBeenCalled();
  });

  it('records trusted facts and immutable envelopes while disabled, with no caller provenance', async () => {
    const row = await order();
    const event = {
      eventId: 'event',
      orderId: row.slantPublicOrderId,
      status: 'SHIPPED',
      metadata: {
        provenance: 'forged',
        tracking: 'PRIVATE',
        trackingNumber: 'TRACK-123',
      },
    };
    expect((await webhook(event)).status).toBe(200);
    const fact = await db
      .select()
      .from(schema.orderEventsTable)
      .where(
        eq(
          schema.orderEventsTable.dedupeKey,
          slantEventKey(row.id, row.slantPublicOrderId!, 'event'),
        ),
      )
      .get();
    expect(fact).toMatchObject({
      type: 'slant_status_changed',
      previousStatus: 'PROCESSING',
      nextStatus: 'SHIPPED',
    });
    expect(fact?.metadata).not.toContain('PRIVATE');
    expect(fact?.metadata).not.toContain('forged');
    expect(fact?.metadata).toContain('TRACK-123');
    expect((await currentOrder(row.id))?.paymentStatus).toBe('paid');
    expect(await db.select().from(attempts)).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
    expect((await webhook(event, 'test-secret', true)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await webhook(event, 'test-secret', true)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects ID reuse and regressions, and preserves terminal manufacturing state', async () => {
    const row = await order();
    const event = {
      eventId: 'event',
      orderId: row.slantPublicOrderId,
      status: 'SHIPPED',
    };
    expect((await webhook(event)).status).toBe(200);
    expect((await webhook({ ...event, status: 'DELIVERED' })).status).toBe(409);
    expect(
      (await webhook({ ...event, eventId: 'backward', status: 'PROCESSING' }))
        .status,
    ).toBe(409);
    expect(
      (await webhook({ ...event, eventId: 'cancel', status: 'CANCELED' }))
        .status,
    ).toBe(409);
    expect(
      (await webhook({ ...event, eventId: 'delivered', status: 'DELIVERED' }))
        .status,
    ).toBe(200);
    expect((await webhook({ ...event, eventId: 'late' })).status).toBe(409);
    expect((await currentOrder(row.id))?.slantStatus).toBe('DELIVERED');
  });

  it('recovers both lifecycle facts after later advancement without manufacturing new events', async () => {
    const row = await order();
    for (const status of ['SHIPPED', 'DELIVERED'] as const)
      expect(
        (
          await recordSlantLifecycle(db, {
            eventId: status,
            orderId: row.slantPublicOrderId!,
            status,
          })
        ).status,
      ).toBe(200);
    await db
      .delete(schema.orderEventsTable)
      .where(
        and(
          eq(schema.orderEventsTable.orderId, row.id),
          eq(schema.orderEventsTable.type, 'square_fulfillment_processed'),
        ),
      );
    await reconcileSquareNotifications(db, mail, row.id);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(call => call[0].subject)).toEqual([
      `Order #${row.id} shipped`,
      `Order #${row.id} delivered`,
    ]);
  });

  it('manufacturing cancellation before processing neither claims nor performs a refund', async () => {
    const row = await order();
    await db
      .update(schema.ordersTable)
      .set({
        slantStatus: null,
        status: 'paid_fulfillment_failed',
        fulfillmentState: 'drafted',
      })
      .where(eq(schema.ordersTable.id, row.id));
    await db
      .delete(schema.orderEventsTable)
      .where(
        and(
          eq(schema.orderEventsTable.orderId, row.id),
          eq(schema.orderEventsTable.type, 'square_fulfillment_processed'),
        ),
      );
    expect(
      (
        await webhook(
          {
            eventId: 'cancel',
            orderId: row.slantPublicOrderId,
            status: 'CANCELED',
          },
          'test-secret',
          true,
        )
      ).status,
    ).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].text).toContain(
      'does not confirm a payment refund',
    );
    expect(await currentOrder(row.id)).toMatchObject({
      slantStatus: 'CANCELED',
      paymentStatus: 'paid',
      squarePaymentId: row.squarePaymentId,
    });
  });

  it('does not trust old events even with lookalike caller metadata or external IDs', async () => {
    const row = await order();
    await db.insert(schema.orderEventsTable).values({
      orderId: row.id,
      source: 'slant3d',
      actor: 'slant3d',
      type: 'slant_status_changed',
      externalEventId: 'historic',
      nextStatus: 'SHIPPED',
      metadata: JSON.stringify({
        provenance: 'configured-secret-v1',
        slantOrderId: row.slantPublicOrderId,
      }),
    });
    await expect(
      enqueueOrderNotification(db, row.id, 'shipped'),
    ).rejects.toThrow('notification_lifecycle_unverified');
    expect(
      (
        await webhook({
          eventId: row.squarePaymentId,
          orderId: row.slantPublicOrderId,
          status: 'SHIPPED',
        })
      ).status,
    ).toBe(200);
  });

  it('atomically rolls back the event when a later batch statement fails', async () => {
    const row = await order();
    const original = db.batch.bind(db);
    const spy = vi.spyOn(db, 'batch').mockImplementationOnce(queries =>
      original([
        queries[0],
        db.insert(schema.users).values({
          id: 'test-owner',
          name: 'Duplicate',
          email: 'duplicate@example.com',
        }),
      ]),
    );
    await expect(
      recordSlantLifecycle(db, {
        eventId: 'rollback',
        orderId: row.slantPublicOrderId!,
        status: 'SHIPPED',
      }),
    ).rejects.toThrow();
    spy.mockRestore();
    expect((await currentOrder(row.id))?.slantStatus).toBe('PROCESSING');
    expect(
      await db
        .select()
        .from(schema.orderEventsTable)
        .where(eq(schema.orderEventsTable.externalEventId, 'rollback')),
    ).toHaveLength(0);
  });

  it('recovers intent after an insert outage by replaying the same accepted event', async () => {
    const row = await order();
    const event = {
      eventId: 'recover',
      orderId: row.slantPublicOrderId!,
      status: 'SHIPPED' as const,
    };
    expect((await recordSlantLifecycle(db, event)).status).toBe(200);
    const spy = vi.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('controlled outage');
    });
    await expect(
      reconcileSquareNotifications(db, mail, row.id),
    ).rejects.toThrow('controlled outage');
    spy.mockRestore();
    expect((await webhook(event, 'test-secret', true)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('concurrent duplicate and advancing events preserve monotonic state and one intent per milestone', async () => {
    const row = await order();
    const event = {
      eventId: 'same',
      orderId: row.slantPublicOrderId!,
      status: 'SHIPPED' as const,
    };
    await Promise.all(
      Array.from({ length: 5 }, () => recordSlantLifecycle(db, event)),
    );
    expect(
      await db
        .select()
        .from(schema.orderEventsTable)
        .where(eq(schema.orderEventsTable.externalEventId, 'same')),
    ).toHaveLength(1);
    const results = await Promise.all(
      ['SHIPPED', 'DELIVERED'].map(status =>
        recordSlantLifecycle(db, {
          eventId: status,
          orderId: row.slantPublicOrderId!,
          status: status as 'SHIPPED' | 'DELIVERED',
        }),
      ),
    );
    if ((await currentOrder(row.id))?.slantStatus !== 'DELIVERED')
      await recordSlantLifecycle(db, {
        eventId: 'DELIVERED',
        orderId: row.slantPublicOrderId!,
        status: 'DELIVERED',
      });
    expect(results.every(result => [200, 409].includes(result.status))).toBe(
      true,
    );
    expect((await currentOrder(row.id))?.slantStatus).toBe('DELIVERED');
    await reconcileSquareNotifications(db, mail, row.id);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('authenticated webhook failure boundaries', () => {
  it('returns retryable sanitized errors without exposing database/provider details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = 'PRIVATE customer@example.com token';
    const response = await app.request(
      '/webhook/slant3d',
      await signedSlant(slantEnvelope({ eventId: 'failed', orderId: 'retained', status: 'SHIPPED' }), 'secret'),
      {
        DB: {
          prepare() {
            throw new Error(secret);
          },
        },
        ...mail,
        SLANT_WEBHOOK_SECRET: 'secret',
        SLANT_PLATFORM_ID: 'test-platform-id',
      },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(send).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

it('accepts provider envelopes without event IDs and deduplicates freshly signed redelivery', async () => {
  const row = await order();
  const body = { event_type: 'order.shipped', platform_id: 'test-platform-id', data: { order: {
    public_id: row.slantPublicOrderId, status: 'SHIPPED', tracking_number: 'TRACK-PROVIDER',
  } } };
  const env = { DB: bindings.NOTIFICATIONS_TEST_DB, ...mail, ORDER_NOTIFICATIONS_ENABLED: 'false', SLANT_WEBHOOK_SECRET: 'test-secret', SLANT_PLATFORM_ID: 'test-platform-id' };
  for (const timestamp of [String(Date.now()), String(Date.now() + 1000)]) {
    expect((await app.request('/webhook/slant3d', await signedSlant({ ...body, timestamp }, 'test-secret', timestamp), env)).status).toBe(200);
  }
  expect((await currentOrder(row.id))?.slantStatus).toBe('SHIPPED');
  expect((await db.select().from(schema.orderEventsTable)).filter(event => event.type === 'slant_status_changed')).toHaveLength(1);
  expect((await db.select().from(attempts)).filter(attempt => attempt.notificationType === 'order_shipped')).toHaveLength(1);
  expect(send).not.toHaveBeenCalled();
});

it.each(['tampering', 'stale', 'future', 'platform', 'malformed-signature'])('rejects %s before persistence', async fault => {
  const row = await order();
  const body = { event_type: 'order.shipped', platform_id: fault === 'platform' ? 'wrong' : 'test-platform-id', data: { order: { public_id: row.slantPublicOrderId, status: 'SHIPPED' } } };
  const timestamp = String(Date.now() + (fault === 'stale' ? -600_000 : fault === 'future' ? 600_000 : 0));
  const options = await signedSlant(body, 'test-secret', timestamp);
  if (fault === 'tampering') options.body += ' ';
  if (fault === 'malformed-signature') options.headers['X-Webhook-Signature-256'] = 'sha256=xyz';
  const response = await app.request('/webhook/slant3d', options, { DB: bindings.NOTIFICATIONS_TEST_DB, ...mail, SLANT_WEBHOOK_SECRET: 'test-secret', SLANT_PLATFORM_ID: 'test-platform-id' });
  expect(response.status).toBe(401);
  expect((await currentOrder(row.id))?.slantStatus).toBe('PROCESSING');
  expect(send).not.toHaveBeenCalled();
});

it('acknowledges unrelated authenticated provider events without lifecycle effects', async () => {
  const response = await app.request('/webhook/slant3d', await signedSlant({ event_type: 'file.updated', platform_id: 'test-platform-id', data: {} }), {
    DB: bindings.NOTIFICATIONS_TEST_DB, ...mail, SLANT_WEBHOOK_SECRET: 'test-secret', SLANT_PLATFORM_ID: 'test-platform-id',
  });
  expect(await response.json()).toEqual({ success: true, ignored: true });
  expect(await db.select().from(schema.orderEventsTable)).toHaveLength(0);
  expect(send).not.toHaveBeenCalled();
});
