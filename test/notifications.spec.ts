import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import * as schema from '../src/db/schema';
import { mockBetterAuth } from './mocks/auth';

vi.unmock('drizzle-orm/d1');

import { orderNotificationAttemptsTable as attempts } from '../src/db/schema';
import {
  deliverNotification,
  enqueueAdminFailure,
  enqueueOrderNotification,
  type NotificationEnv,
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
      orderNumber: 'PRIVATE',
      customerEmail: 'customer@example.com',
      status: 'processing',
      slantStatus: 'PROCESSING',
    })
    .returning();
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
      text: `Thank you for your order. Order #${row.id} is confirmed and is being processed.`,
    });
  });

  it('pre-provider configuration failure retries the original recipient and content', async () => {
    const row = await order();
    const queued = await enqueueOrderNotification(db, row.id, 'confirmed');
    expect(await deliverNotification(db, {}, queued.id)).toMatchObject({
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
    await deliverNotification(db, {}, queued.id);
    expect(await attempt(queued.id)).toMatchObject({
      status: 'failed',
      recipientEmail: '',
    });
    await deliverNotification(
      db,
      { ORDER_ADMIN_EMAIL: 'first@example.com' },
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
    ).rejects.toThrow('notification_order_status_mismatch');
    await db
      .update(schema.ordersTable)
      .set({ customerEmail: 'bad\r\nBcc: evil@example.com' })
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
  ])('requires authentication and privileged organization membership: %s', async path => {
    const method = path.includes('/resend/') ? 'POST' : 'GET';
    expect((await request(path, method)).status).toBe(401);
    await session('user');
    const response = await request(path, method);
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
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
    expect(listing.headers.get('cache-control')).toBe('no-store');
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
    ])
      expect(Object.keys(spec.paths)).toContain(path);
  });
});
