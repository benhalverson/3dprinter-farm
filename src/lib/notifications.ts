import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';
import type * as schema from '../db/schema';
import {
  orderNotificationAttemptsTable as attempts,
  ordersTable,
} from '../db/schema';
import type { Bindings } from '../types';

type Database = DrizzleD1Database<typeof schema>;
type Attempt = typeof attempts.$inferSelect;
export type NotificationEnv = Pick<
  Bindings,
  'ORDER_EMAIL' | 'ORDER_ADMIN_EMAIL'
>;
export type OrderNotificationStatus =
  | 'confirmed'
  | 'shipped'
  | 'delivered'
  | 'canceled';
export type FailureCategory =
  | 'fulfillment_failed'
  | 'webhook_failed'
  | 'email_delivery_failed';
const sender = 'Lulu Speedworks <noreply@luluspeedworks.com>';
const email = z
  .string()
  .email()
  .max(254)
  .refine(value => !/[\r\n]/.test(value));

/** Use a structured key so references containing separators cannot collide. */
function deliveryKey(reference: string, type: string, transition: string) {
  return JSON.stringify(['order-email-v1', reference, type, transition]);
}

/** Persist one immutable envelope; conflict means this event was already queued. */
async function enqueue(
  db: Database,
  envelope: {
    orderId: number | null;
    reference: string;
    notificationType: string;
    recipientEmail: string;
    subject: string;
    textContent: string;
    statusTransition: string;
    source: 'square' | 'slant3d' | 'notifications';
  },
) {
  const { reference, ...values } = envelope;
  const key = deliveryKey(
    reference,
    values.notificationType,
    values.statusTransition,
  );
  await db
    .insert(attempts)
    .values({
      ...values,
      status: 'pending',
      senderEmail: sender,
      deliveryKey: key,
      idempotencyKey: key,
    })
    .onConflictDoNothing({ target: attempts.deliveryKey });
  const row = await db
    .select()
    .from(attempts)
    .where(eq(attempts.deliveryKey, key))
    .get();
  if (!row) throw new Error('notification_enqueue_failed');
  return row;
}

/**
 * Queue only after an authenticated Square fulfillment or Slant lifecycle event.
 * The durable order owns the recipient; callers cannot supply another address.
 * Producers must replay this call after a failed enqueue before acknowledging events.
 */
export async function enqueueOrderNotification(
  db: Database,
  orderId: number,
  status: OrderNotificationStatus,
) {
  const type =
    status === 'confirmed' ? 'order_confirmation' : `order_${status}`;
  const existing = await db
    .select()
    .from(attempts)
    .where(eq(attempts.deliveryKey, deliveryKey(String(orderId), type, status)))
    .get();
  if (existing) return existing;
  const order = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId))
    .get();
  if (!order) throw new Error('notification_order_not_found');
  const recipient = email.safeParse(order.customerEmail);
  if (!recipient.success) throw new Error('notification_recipient_invalid');
  const expectedStatus =
    status === 'confirmed' ? 'PROCESSING' : status.toUpperCase();
  if (order.slantStatus?.toUpperCase() !== expectedStatus) {
    throw new Error('notification_order_status_mismatch');
  }
  // Numbers are safe in mail headers and do not interpolate provider/customer text.
  const reference = `Order #${order.id}`;
  return enqueue(db, {
    orderId: order.id,
    reference: String(order.id),
    notificationType:
      status === 'confirmed' ? 'order_confirmation' : `order_${status}`,
    recipientEmail: recipient.data,
    subject: `${reference} ${status}`,
    textContent:
      status === 'confirmed'
        ? `Thank you for your order. ${reference} is confirmed and is being processed.`
        : `${reference} has been ${status}.`,
    statusTransition: status,
    source: status === 'confirmed' ? 'square' : 'slant3d',
  });
}

/** Queue a redacted alert using server configuration, never a provider error body. */
export async function enqueueAdminFailure(
  db: Database,
  env: NotificationEnv,
  reference: string,
  category: FailureCategory,
  orderId: number | null = null,
) {
  const recipient = email.safeParse(env.ORDER_ADMIN_EMAIL);
  return enqueue(db, {
    orderId,
    reference,
    notificationType: 'admin_failure_alert',
    recipientEmail: recipient.success ? recipient.data : '',
    subject: 'Lulu Speedworks order notification alert',
    textContent: `An order requires attention. Category: ${category}.${orderId === null ? '' : ` Local order: ${orderId}.`} Review the authenticated order administration tools.`,
    statusTransition: category,
    source: 'notifications',
  });
}

/** Return status only; never leak envelopes or provider diagnostics in retry responses. */
function result(row: Attempt) {
  return {
    id: row.id,
    status: row.status,
    providerMessageId: row.providerMessageId,
  };
}

/**
 * Claim delivery atomically before any provider call. A sending/unknown attempt is
 * never reclaimed: Cloudflare acceptance cannot be atomically committed with D1.
 * A crash or ambiguous exception therefore requires operator reconciliation.
 * Only pre-provider failures are safe to retry, preserving the original envelope.
 */
export async function deliverNotification(
  db: Database,
  env: NotificationEnv,
  id: number,
) {
  let row = await db.select().from(attempts).where(eq(attempts.id, id)).get();
  if (!row) return null;
  // Legacy attempts have no durable envelope/claim key and must never be replayed.
  if (!row.deliveryKey) return result(row);
  if (!['pending', 'failed'].includes(row.status)) {
    // A retry can repair an interrupted admin alert without resending the
    // customer message. In-flight claims get a conservative ten-minute grace.
    if (
      row.status === 'unknown' ||
      (row.status === 'sending' &&
        Date.parse(row.updatedAt) <= Date.now() - 600_000)
    ) {
      await recoverDeliveryAlert(db, env, row);
    }
    return result(row);
  }
  // Missing admin configuration must not lose a durable failure alert. Pin the
  // first valid configured address atomically and retain it on every retry.
  if (row.notificationType === 'admin_failure_alert' && !row.recipientEmail) {
    const recipient = email.safeParse(env.ORDER_ADMIN_EMAIL);
    if (recipient.success) {
      await db
        .update(attempts)
        .set({ recipientEmail: recipient.data })
        .where(
          and(
            eq(attempts.id, id),
            eq(attempts.recipientEmail, ''),
            inArray(attempts.status, ['pending', 'failed']),
          ),
        );
      row = await db.select().from(attempts).where(eq(attempts.id, id)).get();
      if (!row) return null;
    }
  }
  const validEnvelope =
    row.senderEmail === sender &&
    email.safeParse(row.recipientEmail).success &&
    !!row.subject &&
    !/[\r\n]/.test(row.subject) &&
    !!row.textContent;
  if (!env.ORDER_EMAIL || !validEnvelope) {
    await db
      .update(attempts)
      .set({
        status: 'failed',
        errorMessage: 'notification_configuration_invalid',
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(attempts.id, id),
          inArray(attempts.status, ['pending', 'failed']),
        ),
      );
    const current = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, id))
      .get();
    if (current?.status === 'failed')
      await recoverDeliveryAlert(db, env, current);
    return current ? result(current) : null;
  }
  const token = crypto.randomUUID();
  const [claimed] = await db
    .update(attempts)
    .set({
      status: 'sending',
      claimToken: token,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(attempts.id, id), inArray(attempts.status, ['pending', 'failed'])),
    )
    .returning();
  if (!claimed) {
    const current = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, id))
      .get();
    return current ? result(current) : null;
  }
  let messageId: string;
  try {
    const accepted = await env.ORDER_EMAIL.send({
      from: claimed.senderEmail ?? sender,
      to: claimed.recipientEmail,
      subject: claimed.subject ?? '',
      text: claimed.textContent ?? '',
    });
    if (!accepted.messageId) throw new Error('notification_unacknowledged');
    messageId = accepted.messageId;
  } catch {
    await db
      .update(attempts)
      .set({
        status: 'unknown',
        errorMessage: 'notification_delivery_unknown',
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(attempts.id, id),
          eq(attempts.claimToken, token),
          eq(attempts.status, 'sending'),
        ),
      );
    await recoverDeliveryAlert(db, env, claimed);
    return { id, status: 'unknown', providerMessageId: null };
  }
  // Keep acknowledgement outside the provider catch. If D1 fails the durable
  // sending claim still forbids a second provider call.
  const at = new Date().toISOString();
  await db
    .update(attempts)
    .set({
      status: 'sent',
      providerMessageId: messageId,
      sentAt: at,
      updatedAt: at,
      errorMessage: null,
    })
    .where(
      and(
        eq(attempts.id, id),
        eq(attempts.claimToken, token),
        eq(attempts.status, 'sending'),
      ),
    );
  return { id, status: 'sent', providerMessageId: messageId };
}

/** Repair alert enqueue/delivery independently; never resend an ambiguous customer email. */
async function recoverDeliveryAlert(
  db: Database,
  env: NotificationEnv,
  row: Attempt,
) {
  if (row.notificationType === 'admin_failure_alert') return;
  try {
    const alert = await enqueueAdminFailure(
      db,
      env,
      `notification:${row.id}`,
      'email_delivery_failed',
      row.orderId,
    );
    await deliverNotification(db, env, alert.id);
  } catch {
    // The customer's unknown/sending row remains a durable reconciliation marker.
    console.error('notification.admin_alert_unavailable');
  }
}
