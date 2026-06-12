import { eq, and } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { notificationAttempts } from '../db/schema';
import type * as schema from '../db/schema';
import type { Bindings } from '../types';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type NotificationType =
  | 'order_confirmation'
  | 'order_shipped'
  | 'order_delivered'
  | 'order_canceled'
  | 'admin_failure_alert';

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface SendNotificationParams {
  orderId: string;
  notificationType: NotificationType;
  recipientEmail: string;
  subject: string;
  textContent: string;
  htmlContent?: string;
  statusTransition?: string;
}

export interface NotificationResult {
  success: boolean;
  status: NotificationStatus;
  providerMessageId?: string;
  error?: string;
  skipped?: boolean;
}

// ─── Idempotency Key ───────────────────────────────────────────────────────────

export function buildIdempotencyKey(
  orderId: string,
  notificationType: NotificationType,
  statusTransition?: string,
): string {
  return `${orderId}:${notificationType}:${statusTransition || 'default'}`;
}

// ─── Mailjet Sender ────────────────────────────────────────────────────────────

async function sendViaMailjet(
  env: Bindings,
  recipientEmail: string,
  subject: string,
  textContent: string,
  htmlContent?: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const auth = `${env.MAILJET_API_KEY}:${env.MAILJET_API_SECRET}`;
  const base64Auth = Buffer.from(auth).toString('base64');

  const message: Record<string, unknown> = {
    From: {
      Email: env.MAILJET_SENDER_EMAIL,
      Name: env.MAILJET_SENDER_NAME,
    },
    To: [{ Email: recipientEmail }],
    Subject: subject,
    TextPart: textContent,
  };

  if (htmlContent) {
    message.HTMLPart = htmlContent;
  }

  try {
    const response = await fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${base64Auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ Messages: [message] }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Mailjet HTTP ${response.status}: ${errorText}` };
    }

    const result = (await response.json()) as {
      Messages?: Array<{
        Status?: string;
        To?: Array<{ MessageID?: number }>;
      }>;
    };

    const msg = result.Messages?.[0];
    const messageId = msg?.To?.[0]?.MessageID?.toString();

    if (msg?.Status === 'success') {
      return { success: true, messageId };
    }

    return { success: false, error: `Mailjet status: ${msg?.Status || 'unknown'}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ─── Main Send Function (idempotent) ───────────────────────────────────────────

export async function sendNotification(
  db: DrizzleD1Database<typeof schema>,
  env: Bindings,
  params: SendNotificationParams,
): Promise<NotificationResult> {
  const idempotencyKey = buildIdempotencyKey(
    params.orderId,
    params.notificationType,
    params.statusTransition,
  );

  // Check for existing attempt with the same idempotency key
  const existing = await db
    .select()
    .from(notificationAttempts)
    .where(eq(notificationAttempts.idempotencyKey, idempotencyKey))
    .get();

  if (existing && (existing.status === 'sent' || existing.status === 'skipped')) {
    return { success: true, status: existing.status as NotificationStatus, skipped: true };
  }

  const now = new Date();

  // Create or update attempt record as pending
  if (!existing) {
    await db.insert(notificationAttempts).values({
      orderId: params.orderId,
      notificationType: params.notificationType,
      recipientEmail: params.recipientEmail,
      status: 'pending',
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Send via Mailjet
  const result = await sendViaMailjet(
    env,
    params.recipientEmail,
    params.subject,
    params.textContent,
    params.htmlContent,
  );

  // Update the record
  if (result.success) {
    await db
      .update(notificationAttempts)
      .set({
        status: 'sent',
        providerMessageId: result.messageId || null,
        sentAt: now,
        updatedAt: now,
      })
      .where(eq(notificationAttempts.idempotencyKey, idempotencyKey));

    return { success: true, status: 'sent', providerMessageId: result.messageId };
  }

  await db
    .update(notificationAttempts)
    .set({
      status: 'failed',
      errorMessage: result.error || 'Unknown error',
      updatedAt: now,
    })
    .where(eq(notificationAttempts.idempotencyKey, idempotencyKey));

  return { success: false, status: 'failed', error: result.error };
}

// ─── Convenience Helpers ───────────────────────────────────────────────────────

export async function sendOrderConfirmation(
  db: DrizzleD1Database<typeof schema>,
  env: Bindings,
  orderId: string,
  customerEmail: string,
  orderNumber: string,
): Promise<NotificationResult> {
  return sendNotification(db, env, {
    orderId,
    notificationType: 'order_confirmation',
    recipientEmail: customerEmail,
    subject: `Order Confirmation - ${orderNumber}`,
    textContent: `Thank you for your order! Your order ${orderNumber} has been confirmed and is being processed. We'll send you updates as your order progresses.`,
    htmlContent: `<h2>Order Confirmed</h2><p>Thank you for your order! Your order <strong>${orderNumber}</strong> has been confirmed and is being processed.</p><p>We'll send you updates as your order progresses.</p>`,
    statusTransition: 'confirmed',
  });
}

export async function sendOrderStatusUpdate(
  db: DrizzleD1Database<typeof schema>,
  env: Bindings,
  orderId: string,
  customerEmail: string,
  orderNumber: string,
  newStatus: 'shipped' | 'delivered' | 'canceled',
): Promise<NotificationResult> {
  const statusMessages: Record<string, { subject: string; text: string; html: string }> = {
    shipped: {
      subject: `Order Shipped - ${orderNumber}`,
      text: `Great news! Your order ${orderNumber} has been shipped. You should receive it soon.`,
      html: `<h2>Order Shipped</h2><p>Great news! Your order <strong>${orderNumber}</strong> has been shipped.</p>`,
    },
    delivered: {
      subject: `Order Delivered - ${orderNumber}`,
      text: `Your order ${orderNumber} has been delivered. Thank you for your purchase!`,
      html: `<h2>Order Delivered</h2><p>Your order <strong>${orderNumber}</strong> has been delivered. Thank you for your purchase!</p>`,
    },
    canceled: {
      subject: `Order Canceled - ${orderNumber}`,
      text: `Your order ${orderNumber} has been canceled. If you have questions, please contact us.`,
      html: `<h2>Order Canceled</h2><p>Your order <strong>${orderNumber}</strong> has been canceled. If you have questions, please contact us.</p>`,
    },
  };

  const msg = statusMessages[newStatus];
  const notificationType: NotificationType = `order_${newStatus}` as NotificationType;

  return sendNotification(db, env, {
    orderId,
    notificationType,
    recipientEmail: customerEmail,
    subject: msg.subject,
    textContent: msg.text,
    htmlContent: msg.html,
    statusTransition: newStatus,
  });
}

export async function sendAdminFailureAlert(
  db: DrizzleD1Database<typeof schema>,
  env: Bindings,
  orderId: string,
  failureContext: string,
  errorDetails: string,
): Promise<NotificationResult> {
  const adminEmail = env.MAILJET_SENDER_EMAIL; // Admin receives alerts at the sender email

  return sendNotification(db, env, {
    orderId,
    notificationType: 'admin_failure_alert',
    recipientEmail: adminEmail,
    subject: `[ALERT] Order Processing Failure - ${orderId}`,
    textContent: `Order processing failure detected.\n\nOrder ID: ${orderId}\nContext: ${failureContext}\nError: ${errorDetails}\n\nPlease investigate.`,
    htmlContent: `<h2>⚠️ Order Processing Failure</h2><p><strong>Order ID:</strong> ${orderId}</p><p><strong>Context:</strong> ${failureContext}</p><p><strong>Error:</strong> ${errorDetails}</p><p>Please investigate immediately.</p>`,
    statusTransition: failureContext,
  });
}

// ─── Resend Logic ──────────────────────────────────────────────────────────────

export async function resendNotification(
  db: DrizzleD1Database<typeof schema>,
  env: Bindings,
  notificationId: number,
): Promise<NotificationResult> {
  const attempt = await db
    .select()
    .from(notificationAttempts)
    .where(eq(notificationAttempts.id, notificationId))
    .get();

  if (!attempt) {
    return { success: false, status: 'failed', error: 'Notification not found' };
  }

  if (attempt.status === 'sent') {
    return { success: true, status: 'skipped', skipped: true };
  }

  // Reset idempotency by updating the existing record
  const now = new Date();

  const result = await sendViaMailjet(
    env,
    attempt.recipientEmail,
    `[Resent] Order Notification - ${attempt.orderId}`,
    `This is a resent notification for order ${attempt.orderId} (type: ${attempt.notificationType}).`,
  );

  if (result.success) {
    await db
      .update(notificationAttempts)
      .set({
        status: 'sent',
        providerMessageId: result.messageId || null,
        errorMessage: null,
        sentAt: now,
        updatedAt: now,
      })
      .where(eq(notificationAttempts.id, notificationId));

    return { success: true, status: 'sent', providerMessageId: result.messageId };
  }

  await db
    .update(notificationAttempts)
    .set({
      status: 'failed',
      errorMessage: result.error || 'Unknown error',
      updatedAt: now,
    })
    .where(eq(notificationAttempts.id, notificationId));

  return { success: false, status: 'failed', error: result.error };
}

// ─── Query Helpers ─────────────────────────────────────────────────────────────

export async function getNotificationsByOrderId(
  db: DrizzleD1Database<typeof schema>,
  orderId: string,
) {
  return db
    .select()
    .from(notificationAttempts)
    .where(eq(notificationAttempts.orderId, orderId))
    .all();
}

export async function getFailedNotifications(
  db: DrizzleD1Database<typeof schema>,
) {
  return db
    .select()
    .from(notificationAttempts)
    .where(eq(notificationAttempts.status, 'failed'))
    .all();
}
