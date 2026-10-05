import { and, eq, exists, inArray, notExists, or } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';
import type * as schema from '../db/schema';
import {
  orderNotificationAttemptsTable as attempts,
  checkoutAttempts,
  orderEventsTable,
  ordersTable,
} from '../db/schema';
import type { Bindings } from '../types';

type Database = DrizzleD1Database<typeof schema>;
type Attempt = typeof attempts.$inferSelect;
export type NotificationEnv = Pick<
  Bindings,
  'ORDER_EMAIL' | 'ORDER_ADMIN_EMAIL' | 'ORDER_NOTIFICATIONS_ENABLED'
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

/** Match the actual PR228 durable payment event to the immutable checkout identity. */
async function verifiedSquareOrder(db: Database, orderId: number) {
  const order = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId))
    .get();
  if (
    !order ||
    order.source !== 'online' ||
    order.fulfillmentType !== 'slant' ||
    order.paymentStatus !== 'paid' ||
    !order.checkoutAttemptId ||
    !order.squarePaymentId ||
    !order.squareOrderId
  )
    return null;
  const checkout = await db
    .select()
    .from(checkoutAttempts)
    .where(eq(checkoutAttempts.id, order.checkoutAttemptId))
    .get();
  if (
    !checkout ||
    checkout.state !== 'paid' ||
    checkout.ownerId !== order.userId ||
    checkout.cartId !== order.cartId ||
    checkout.squarePaymentId !== order.squarePaymentId ||
    checkout.squareOrderId !== order.squareOrderId
  )
    return null;
  const event = await db
    .select()
    .from(orderEventsTable)
    .where(
      and(
        eq(orderEventsTable.orderId, order.id),
        eq(orderEventsTable.source, 'square'),
        eq(orderEventsTable.actor, 'square'),
        eq(orderEventsTable.type, 'square_payment_verified'),
        eq(orderEventsTable.dedupeKey, `square-paid:${order.squarePaymentId}`),
        eq(orderEventsTable.externalEventId, order.squarePaymentId),
        eq(orderEventsTable.nextStatus, 'paid'),
      ),
    )
    .get();
  return event ? { order, checkout } : null;
}

/**
 * Recover one confirmation from real Square evidence, including later SHIPPED or
 * DELIVERED state. The immutable checkout recipient must match its order snapshot.
 * Slant lifecycle emails remain blocked until authenticated, ordered, atomic
 * lifecycle evidence is available; old Slant rows are not trusted retroactively.
 */
export async function enqueueOrderNotification(
  db: Database,
  orderId: number,
  status: OrderNotificationStatus,
) {
  if (status !== 'confirmed')
    throw new Error('notification_lifecycle_unverified');
  const existing = await db
    .select()
    .from(attempts)
    .where(
      eq(
        attempts.deliveryKey,
        deliveryKey(String(orderId), 'order_confirmation', status),
      ),
    )
    .get();
  if (existing) return existing;
  const verified = await verifiedSquareOrder(db, orderId);
  if (!verified) throw new Error('notification_square_unverified');
  const { order, checkout } = verified;
  if (
    order.fulfillmentState !== 'processed' ||
    order.slantStatus === 'CANCELED' ||
    order.status === 'canceled'
  )
    throw new Error('notification_order_status_mismatch');
  const completed = await db
    .select()
    .from(orderEventsTable)
    .where(
      and(
        eq(orderEventsTable.orderId, orderId),
        eq(orderEventsTable.source, 'square'),
        eq(orderEventsTable.actor, 'square'),
        eq(orderEventsTable.type, 'square_fulfillment_processed'),
        eq(orderEventsTable.dedupeKey, `square-fulfilled:${checkout.id}`),
        eq(orderEventsTable.externalEventId, checkout.squarePaymentId ?? ''),
        inArray(orderEventsTable.nextStatus, [
          'PROCESSING',
          'SHIPPED',
          'DELIVERED',
        ]),
      ),
    )
    .get();
  if (!completed) throw new Error('notification_fulfillment_unverified');
  const recipient = email.safeParse(checkout.customerEmail);
  let snapshotEmail: unknown;
  try {
    snapshotEmail = JSON.parse(order.customerSnapshot ?? 'null')?.email;
  } catch {
    throw new Error('notification_recipient_invalid');
  }
  if (!recipient.success || recipient.data !== snapshotEmail)
    throw new Error('notification_recipient_invalid');
  const reference = `Order #${order.id}`;
  return enqueue(db, {
    orderId,
    reference: String(orderId),
    notificationType: 'order_confirmation',
    recipientEmail: recipient.data,
    subject: `${reference} confirmed`,
    textContent: `Thank you for your order. ${reference} was confirmed for fulfillment.`,
    statusTransition: 'confirmed',
    source: 'square',
  });
}

/**
 * Replay the actual durable Square evidence after webhook/admin fulfillment work.
 * This never creates trusted events or calls a payment/manufacturing provider.
 * It is also the explicit per-order recovery path after a process/DB interruption.
 */
export async function reconcileSquareNotifications(
  db: Database,
  env: NotificationEnv,
  orderId: number,
) {
  const verified = await verifiedSquareOrder(db, orderId);
  if (!verified)
    return {
      verified: false,
      notifications: [] as ReturnType<typeof result>[],
    };
  const { order } = verified;
  if (
    order.fulfillmentState === 'processed' &&
    order.slantStatus !== 'CANCELED' &&
    order.status !== 'canceled'
  ) {
    await enqueueOrderNotification(db, orderId, 'confirmed');
  } else if (order.status === 'paid_fulfillment_failed') {
    await enqueueAdminFailure(
      db,
      env,
      `square-paid:${order.squarePaymentId}`,
      'fulfillment_failed',
      orderId,
    );
  }
  const queued = await db
    .select()
    .from(attempts)
    .where(eq(attempts.orderId, orderId))
    .all();
  const notifications: ReturnType<typeof result>[] = [];
  for (const attempt of queued) {
    if (!attempt.deliveryKey) continue;
    const outcome = await deliverNotification(db, env, attempt.id);
    if (outcome) notifications.push(outcome);
  }
  return { verified: true, notifications };
}

/** Keep payment acknowledgements independent of email; durable evidence permits explicit replay. */
export async function tryReconcileSquareNotifications(
  db: Database,
  env: NotificationEnv,
  orderId: number,
) {
  try {
    await reconcileSquareNotifications(db, env, orderId);
  } catch {
    console.error('notification.square_reconciliation_pending');
  }
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
  if (env.ORDER_NOTIFICATIONS_ENABLED !== 'true')
    return { id, status: 'disabled', providerMessageId: null };
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
  const canceled =
    row.notificationType === 'order_confirmation' && row.orderId !== null
      ? db
          .select({ id: ordersTable.id })
          .from(ordersTable)
          .where(
            and(
              eq(ordersTable.id, row.orderId),
              or(
                eq(ordersTable.status, 'canceled'),
                eq(ordersTable.slantStatus, 'CANCELED'),
              ),
            ),
          )
      : null;
  if (canceled) {
    const [suppressed] = await db
      .update(attempts)
      .set({
        status: 'skipped',
        errorMessage: 'notification_order_canceled',
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(attempts.id, id),
          inArray(attempts.status, ['pending', 'failed']),
          exists(canceled),
        ),
      )
      .returning();
    if (suppressed) return result(suppressed);
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
      and(
        eq(attempts.id, id),
        inArray(attempts.status, ['pending', 'failed']),
        canceled ? notExists(canceled) : undefined,
      ),
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
