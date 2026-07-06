import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  sendAdminFailureAlert,
  sendOrderNotification,
} from '../../src/modules/orderNotifications';
import { mockEnv } from '../mocks/env';

function makeDb({ existing = [] }: { existing?: unknown[] } = {}) {
  const inserts: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: vi.fn().mockResolvedValue(existing),
      }),
    }),
    insert: () => ({
      values: vi.fn(async (payload: unknown) => {
        inserts.push(payload);
      }),
    }),
  };

  return { db: db as never, inserts };
}

const order = {
  id: 42,
  orderNumber: 'ORDER-123456',
  customerEmail: 'customer@example.com',
  status: 'processing',
  slantStatus: 'PROCESSING',
};

describe('order notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  test('sends and persists a customer notification attempt', async () => {
    const { db, inserts } = makeDb();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        Messages: [{ To: [{ MessageID: 123456 }] }],
      }),
    });

    const result = await sendOrderNotification({
      db,
      env: mockEnv(),
      order,
      type: 'order_confirmation',
      statusTransition: 'paid_to_processing',
      source: 'stripe',
    });

    expect(result).toEqual({ status: 'sent', providerMessageId: '123456' });
    expect(inserts).toEqual([
      expect.objectContaining({
        orderId: 42,
        notificationType: 'order_confirmation',
        recipientEmail: 'customer@example.com',
        status: 'sent',
        providerMessageId: '123456',
        statusTransition: 'paid_to_processing',
        source: 'stripe',
      }),
    ]);
  });

  test('skips duplicate sent notifications without calling Mailjet', async () => {
    const { db, inserts } = makeDb({ existing: [{ id: 1, status: 'sent' }] });

    const result = await sendOrderNotification({
      db,
      env: mockEnv(),
      order,
      type: 'order_confirmation',
      statusTransition: 'paid_to_processing',
      source: 'stripe',
    });

    expect(result).toEqual({ status: 'skipped', duplicate: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  test('persists customer email failures and sends an admin alert', async () => {
    const { db, inserts } = makeDb();
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: vi.fn().mockResolvedValue({ ErrorMessage: 'Mailjet failed' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          Messages: [{ To: [{ MessageID: 654321 }] }],
        }),
      });

    const result = await sendOrderNotification({
      db,
      env: mockEnv(),
      order,
      type: 'order_shipped',
      statusTransition: 'PROCESSING_to_SHIPPED',
      source: 'slant3d',
    });

    expect(result.status).toBe('failed');
    expect(inserts).toEqual([
      expect.objectContaining({
        orderId: 42,
        notificationType: 'order_shipped',
        recipientEmail: 'customer@example.com',
        status: 'failed',
      }),
      expect.objectContaining({
        orderId: 42,
        notificationType: 'admin_failure_alert',
        recipientEmail: 'test@example.com',
        status: 'sent',
        providerMessageId: '654321',
      }),
    ]);
  });

  test('can send an admin failure alert without a local order', async () => {
    const { db, inserts } = makeDb();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        Messages: [{ To: [{ MessageID: 999 }] }],
      }),
    });

    const result = await sendAdminFailureAlert({
      db,
      env: mockEnv(),
      source: 'stripe',
      statusTransition: 'slant_draft_failed',
      reason: 'Slant draft failed',
      details: 'HTTP 500',
    });

    expect(result.status).toBe('sent');
    expect(inserts).toEqual([
      expect.objectContaining({
        orderId: null,
        notificationType: 'admin_failure_alert',
        recipientEmail: 'test@example.com',
        status: 'sent',
      }),
    ]);
  });
});
