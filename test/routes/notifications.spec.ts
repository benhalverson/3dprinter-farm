import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildIdempotencyKey,
  sendNotification,
  sendOrderConfirmation,
  sendOrderStatusUpdate,
  sendAdminFailureAlert,
  resendNotification,
} from '../../src/lib/notifications';
import type { Bindings } from '../../src/types';

// Mock environment
function createMockEnv(): Bindings {
  return {
    DB: {} as D1Database,
    JWT_SECRET: 'test-secret',
    BETTER_AUTH_SECRET: 'test-secret-key-minimum-32-characters-long',
    SLANT_API: 'fake-api-key',
    SLANT_API_V2: 'fake-api-key-v2',
    SLANT_PLATFORM_ID: 'test-platform-id',
    BUCKET: {} as R2Bucket,
    PHOTO_BUCKET: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_123',
    DOMAIN: 'example.com',
    COLOR_CACHE: {} as KVNamespace,
    RP_ID: 'example.com',
    RP_NAME: 'ExampleApp',
    RATE_LIMIT_KV: {} as KVNamespace,
    MAILJET_API_KEY: 'test-key',
    MAILJET_API_SECRET: 'test-secret',
    MAILJET_CONTACT_LIST_ID: 'test-list-id',
    MAILJET_TEMPLATE_ID: 'test-template-id',
    MAILJET_SENDER_EMAIL: 'admin@example.com',
    MAILJET_SENDER_NAME: 'Test Sender',
    ENCRYPTION_PASSPHRASE: 'test-passphrase',
    R2_PUBLIC_BASE_URL: 'https://uploads.example.com',
    R2_PHOTO_BASE_URL: 'https://photos.example.com',
  };
}

// Mock DB that stores notification attempts in-memory
function createMockDb() {
  const store: Array<Record<string, unknown>> = [];

  return {
    store,
    select: () => ({
      from: () => ({
        where: (_condition: unknown) => ({
          get: async () => {
            // Search store by idempotency key or id
            return undefined;
          },
          all: async () => store,
        }),
        all: async () => store,
      }),
    }),
    insert: () => ({
      values: (data: Record<string, unknown>) => {
        store.push({ ...data, id: store.length + 1 });
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  } as unknown as Parameters<typeof sendNotification>[0];
}

describe('Notifications Library', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildIdempotencyKey', () => {
    it('builds key from orderId, type, and statusTransition', () => {
      const key = buildIdempotencyKey('order-123', 'order_confirmation', 'confirmed');
      expect(key).toBe('order-123:order_confirmation:confirmed');
    });

    it('uses default when statusTransition is undefined', () => {
      const key = buildIdempotencyKey('order-456', 'admin_failure_alert');
      expect(key).toBe('order-456:admin_failure_alert:default');
    });

    it('generates unique keys for different transitions', () => {
      const key1 = buildIdempotencyKey('order-1', 'order_shipped', 'shipped');
      const key2 = buildIdempotencyKey('order-1', 'order_delivered', 'delivered');
      expect(key1).not.toBe(key2);
    });
  });

  describe('sendNotification', () => {
    it('sends email via Mailjet and returns success', async () => {
      const mockDb = createMockDb();
      const env = createMockEnv();

      // Mock fetch to simulate successful Mailjet response
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            Messages: [{ Status: 'success', To: [{ MessageID: 12345 }] }],
          }),
      });

      const result = await sendNotification(mockDb, env, {
        orderId: 'order-test-1',
        notificationType: 'order_confirmation',
        recipientEmail: 'customer@example.com',
        subject: 'Test Subject',
        textContent: 'Test content',
        statusTransition: 'confirmed',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('sent');
      expect(result.providerMessageId).toBe('12345');
    });

    it('returns failed when Mailjet returns HTTP error', async () => {
      const mockDb = createMockDb();
      const env = createMockEnv();

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const result = await sendNotification(mockDb, env, {
        orderId: 'order-test-2',
        notificationType: 'order_confirmation',
        recipientEmail: 'customer@example.com',
        subject: 'Test Subject',
        textContent: 'Test content',
        statusTransition: 'confirmed',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Mailjet HTTP 500');
    });

    it('skips duplicate notifications based on idempotency key', async () => {
      const env = createMockEnv();

      // Create a mock DB that returns an existing "sent" record
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              get: async () => ({
                id: 1,
                orderId: 'order-dup',
                notificationType: 'order_confirmation',
                status: 'sent',
                idempotencyKey: 'order-dup:order_confirmation:confirmed',
              }),
            }),
          }),
        }),
        insert: () => ({ values: () => Promise.resolve() }),
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      } as unknown as Parameters<typeof sendNotification>[0];

      const result = await sendNotification(mockDb, env, {
        orderId: 'order-dup',
        notificationType: 'order_confirmation',
        recipientEmail: 'customer@example.com',
        subject: 'Test Subject',
        textContent: 'Test content',
        statusTransition: 'confirmed',
      });

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.status).toBe('sent');
    });

    it('handles fetch network errors gracefully', async () => {
      const mockDb = createMockDb();
      const env = createMockEnv();

      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network timeout'));

      const result = await sendNotification(mockDb, env, {
        orderId: 'order-net-err',
        notificationType: 'order_confirmation',
        recipientEmail: 'customer@example.com',
        subject: 'Test Subject',
        textContent: 'Test content',
        statusTransition: 'confirmed',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Network timeout');
    });
  });

  describe('sendOrderConfirmation', () => {
    it('sends confirmation with correct subject and content', async () => {
      const mockDb = createMockDb();
      const env = createMockEnv();

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            Messages: [{ Status: 'success', To: [{ MessageID: 99 }] }],
          }),
      });

      const result = await sendOrderConfirmation(
        mockDb,
        env,
        'order-conf-1',
        'buyer@example.com',
        'ORD-2024-001',
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('sent');

      // Verify Mailjet was called with correct data
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Messages[0].Subject).toContain('ORD-2024-001');
      expect(body.Messages[0].To[0].Email).toBe('buyer@example.com');
    });
  });

  describe('sendOrderStatusUpdate', () => {
    it('sends shipped notification', async () => {
      const mockDb = createMockDb();
      const env = createMockEnv();

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            Messages: [{ Status: 'success', To: [{ MessageID: 100 }] }],
          }),
      });

      const result = await sendOrderStatusUpdate(
        mockDb,
        env,
        'order-ship-1',
        'buyer@example.com',
        'ORD-2024-002',
        'shipped',
      );

      expect(result.success).toBe(true);

      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Messages[0].Subject).toContain('Shipped');
    });

    it('sends canceled notification', async () => {
      const mockDb = createMockDb();
      const env = createMockEnv();

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            Messages: [{ Status: 'success', To: [{ MessageID: 101 }] }],
          }),
      });

      const result = await sendOrderStatusUpdate(
        mockDb,
        env,
        'order-cancel-1',
        'buyer@example.com',
        'ORD-2024-003',
        'canceled',
      );

      expect(result.success).toBe(true);

      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Messages[0].Subject).toContain('Canceled');
    });
  });

  describe('sendAdminFailureAlert', () => {
    it('sends alert to admin email with failure context', async () => {
      const mockDb = createMockDb();
      const env = createMockEnv();

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            Messages: [{ Status: 'success', To: [{ MessageID: 200 }] }],
          }),
      });

      const result = await sendAdminFailureAlert(
        mockDb,
        env,
        'order-fail-1',
        'slant3d_order_creation',
        'HTTP 502 from Slant3D',
      );

      expect(result.success).toBe(true);

      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Messages[0].Subject).toContain('[ALERT]');
      expect(body.Messages[0].To[0].Email).toBe('admin@example.com');
      expect(body.Messages[0].TextPart).toContain('slant3d_order_creation');
    });
  });

  describe('resendNotification', () => {
    it('returns not found for non-existent notification', async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              get: async () => undefined,
            }),
          }),
        }),
      } as unknown as Parameters<typeof resendNotification>[0];

      const env = createMockEnv();
      const result = await resendNotification(mockDb, env, 999);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Notification not found');
    });

    it('skips already-sent notifications', async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              get: async () => ({
                id: 1,
                orderId: 'order-1',
                notificationType: 'order_confirmation',
                recipientEmail: 'test@example.com',
                status: 'sent',
              }),
            }),
          }),
        }),
      } as unknown as Parameters<typeof resendNotification>[0];

      const env = createMockEnv();
      const result = await resendNotification(mockDb, env, 1);

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.status).toBe('skipped');
    });

    it('resends failed notifications', async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              get: async () => ({
                id: 2,
                orderId: 'order-2',
                notificationType: 'order_confirmation',
                recipientEmail: 'test@example.com',
                status: 'failed',
              }),
            }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => Promise.resolve(),
          }),
        }),
      } as unknown as Parameters<typeof resendNotification>[0];

      const env = createMockEnv();

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            Messages: [{ Status: 'success', To: [{ MessageID: 300 }] }],
          }),
      });

      const result = await resendNotification(mockDb, env, 2);

      expect(result.success).toBe(true);
      expect(result.status).toBe('sent');
      expect(result.providerMessageId).toBe('300');
    });
  });
});
