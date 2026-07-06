import { and, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from '../db/schema';
import { orderNotificationAttemptsTable, type ordersTable } from '../db/schema';
import type { Bindings } from '../types';

type Database = DrizzleD1Database<typeof schema>;
type OrderRow = typeof ordersTable.$inferSelect;

export type OrderNotificationType =
  | 'order_confirmation'
  | 'order_shipped'
  | 'order_delivered'
  | 'order_canceled'
  | 'admin_failure_alert';

export type OrderNotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';

type NotificationOrder = Pick<
  OrderRow,
  'id' | 'orderNumber' | 'customerEmail' | 'status' | 'slantStatus'
>;

type NotificationAttemptInput = {
  db: Database;
  env: Bindings;
  orderId: number | null;
  orderNumber?: string | null;
  type: OrderNotificationType;
  recipientEmail: string | null | undefined;
  recipientName?: string | null;
  statusTransition: string;
  source: string;
  subject: string;
  text: string;
  variables?: Record<string, unknown>;
  dedupe?: boolean;
  alertOnFailure?: boolean;
};

export type SendOrderNotificationInput = {
  db: Database;
  env: Bindings;
  order: NotificationOrder;
  type: Exclude<OrderNotificationType, 'admin_failure_alert'>;
  statusTransition: string;
  source: string;
  recipientEmail?: string | null;
  dedupe?: boolean;
  alertOnFailure?: boolean;
  reason?: string | null;
};

export type SendAdminFailureAlertInput = {
  db: Database;
  env: Bindings;
  order?: Partial<NotificationOrder> | null;
  source: string;
  statusTransition: string;
  reason: string;
  details?: string | null;
  dedupe?: boolean;
};

export type NotificationAttemptResult = {
  status: OrderNotificationStatus;
  duplicate?: boolean;
  errorMessage?: string;
  providerMessageId?: string | null;
};

function now() {
  return new Date().toISOString();
}

function notificationIdempotencyKey(input: {
  orderId: number | null;
  type: OrderNotificationType;
  statusTransition: string;
  recipientEmail: string;
}) {
  return [
    input.orderId ?? 'no-order',
    input.type,
    input.statusTransition,
    input.recipientEmail.toLowerCase(),
  ].join(':');
}

function mailjetAuth(env: Bindings) {
  const raw = `${env.MAILJET_API_KEY}:${env.MAILJET_API_SECRET}`;
  if (typeof btoa === 'function') {
    return btoa(raw);
  }
  return Buffer.from(raw).toString('base64');
}

async function readMailjetPayload(response: Response) {
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      // Fall back to text below.
    }
  }

  if (typeof response.text === 'function') {
    try {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  return null;
}

function extractProviderMessageId(payload: unknown): string | null {
  const messageId = (
    payload as {
      Messages?: Array<{
        To?: Array<{ MessageID?: string | number; MessageUUID?: string }>;
      }>;
    }
  )?.Messages?.[0]?.To?.[0];

  if (messageId?.MessageUUID) {
    return messageId.MessageUUID;
  }

  const numericId = String(messageId?.MessageID ?? '');
  return numericId || null;
}

async function sendMailjetMessage(input: {
  env: Bindings;
  recipientEmail: string;
  recipientName?: string | null;
  subject: string;
  text: string;
  variables?: Record<string, unknown>;
}) {
  const response = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${mailjetAuth(input.env)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      Messages: [
        {
          From: {
            Email: input.env.MAILJET_SENDER_EMAIL,
            Name: input.env.MAILJET_SENDER_NAME,
          },
          To: [
            {
              Email: input.recipientEmail,
              Name: input.recipientName ?? input.recipientEmail,
            },
          ],
          Subject: input.subject,
          TextPart: input.text,
          Variables: input.variables ?? {},
        },
      ],
    }),
  });

  if (!response?.ok) {
    const payload = response ? await readMailjetPayload(response) : null;
    throw new Error(
      `Mailjet send failed${response ? ` with ${response.status}` : ''}: ${
        typeof payload === 'string' ? payload : JSON.stringify(payload)
      }`,
    );
  }

  return extractProviderMessageId(await readMailjetPayload(response));
}

async function alreadySent(input: { db: Database; idempotencyKey: string }) {
  const rows = await input.db
    .select()
    .from(orderNotificationAttemptsTable)
    .where(
      and(
        eq(orderNotificationAttemptsTable.idempotencyKey, input.idempotencyKey),
        eq(orderNotificationAttemptsTable.status, 'sent'),
      ),
    );

  return Array.isArray(rows) && rows.length > 0;
}

async function insertAttempt(input: {
  db: Database;
  orderId: number | null;
  type: OrderNotificationType;
  recipientEmail: string;
  status: OrderNotificationStatus;
  providerMessageId?: string | null;
  errorMessage?: string | null;
  statusTransition: string;
  source: string;
  idempotencyKey: string;
  at: string;
}) {
  await input.db.insert(orderNotificationAttemptsTable).values({
    orderId: input.orderId,
    notificationType: input.type,
    recipientEmail: input.recipientEmail,
    status: input.status,
    providerMessageId: input.providerMessageId ?? null,
    errorMessage: input.errorMessage ?? null,
    statusTransition: input.statusTransition,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.at,
    updatedAt: input.at,
    sentAt: input.status === 'sent' ? input.at : null,
  });
}

async function sendNotificationAttempt(
  input: NotificationAttemptInput,
): Promise<NotificationAttemptResult> {
  const at = now();
  const recipientEmail = input.recipientEmail?.trim();
  const idempotencyKey = notificationIdempotencyKey({
    orderId: input.orderId,
    type: input.type,
    statusTransition: input.statusTransition,
    recipientEmail: recipientEmail || 'missing-recipient',
  });

  if (!recipientEmail) {
    await insertAttempt({
      db: input.db,
      orderId: input.orderId,
      type: input.type,
      recipientEmail: 'missing-recipient',
      status: 'skipped',
      errorMessage: 'Missing recipient email',
      statusTransition: input.statusTransition,
      source: input.source,
      idempotencyKey,
      at,
    });
    return { status: 'skipped', errorMessage: 'Missing recipient email' };
  }

  if (
    input.dedupe !== false &&
    (await alreadySent({ db: input.db, idempotencyKey }))
  ) {
    return { status: 'skipped', duplicate: true };
  }

  try {
    const providerMessageId = await sendMailjetMessage({
      env: input.env,
      recipientEmail,
      recipientName: input.recipientName,
      subject: input.subject,
      text: input.text,
      variables: input.variables,
    });

    await insertAttempt({
      db: input.db,
      orderId: input.orderId,
      type: input.type,
      recipientEmail,
      status: 'sent',
      providerMessageId,
      statusTransition: input.statusTransition,
      source: input.source,
      idempotencyKey,
      at,
    });

    return { status: 'sent', providerMessageId };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Notification send failed';

    await insertAttempt({
      db: input.db,
      orderId: input.orderId,
      type: input.type,
      recipientEmail,
      status: 'failed',
      errorMessage,
      statusTransition: input.statusTransition,
      source: input.source,
      idempotencyKey,
      at,
    });

    if (
      input.alertOnFailure !== false &&
      input.type !== 'admin_failure_alert'
    ) {
      await sendAdminFailureAlert({
        db: input.db,
        env: input.env,
        order: {
          id: input.orderId ?? undefined,
          orderNumber: input.orderNumber ?? undefined,
        },
        source: input.source,
        statusTransition: `${input.type}_delivery_failed`,
        reason: `Customer notification ${input.type} failed`,
        details: errorMessage,
      });
    }

    return { status: 'failed', errorMessage };
  }
}

function customerSubject(type: SendOrderNotificationInput['type']) {
  if (type === 'order_confirmation') return 'Your 3D print order is confirmed';
  if (type === 'order_shipped') return 'Your 3D print order has shipped';
  if (type === 'order_delivered') return 'Your 3D print order was delivered';
  return 'Your 3D print order was canceled';
}

function customerBody(input: SendOrderNotificationInput) {
  const orderNumber = input.order.orderNumber;

  if (input.type === 'order_confirmation') {
    return `Order ${orderNumber} is confirmed and has been sent to production.`;
  }
  if (input.type === 'order_shipped') {
    return `Order ${orderNumber} has shipped.`;
  }
  if (input.type === 'order_delivered') {
    return `Order ${orderNumber} has been delivered.`;
  }
  return `Order ${orderNumber} has been canceled.${input.reason ? ` Reason: ${input.reason}` : ''}`;
}

export function notificationTypeForSlantStatus(
  status: string,
): SendOrderNotificationInput['type'] | null {
  if (status === 'SHIPPED') return 'order_shipped';
  if (status === 'DELIVERED') return 'order_delivered';
  if (status === 'CANCELED') return 'order_canceled';
  return null;
}

export async function sendOrderNotification(input: SendOrderNotificationInput) {
  return sendNotificationAttempt({
    db: input.db,
    env: input.env,
    orderId: input.order.id,
    orderNumber: input.order.orderNumber,
    type: input.type,
    recipientEmail: input.recipientEmail ?? input.order.customerEmail,
    statusTransition: input.statusTransition,
    source: input.source,
    subject: customerSubject(input.type),
    text: customerBody(input),
    variables: {
      orderNumber: input.order.orderNumber,
      localStatus: input.order.status,
      slantStatus: input.order.slantStatus,
      reason: input.reason ?? null,
    },
    dedupe: input.dedupe,
    alertOnFailure: input.alertOnFailure,
  });
}

export async function sendAdminFailureAlert(input: SendAdminFailureAlertInput) {
  const orderId = typeof input.order?.id === 'number' ? input.order.id : null;
  const orderNumber = input.order?.orderNumber ?? 'unknown';
  const detail = input.details ? ` Details: ${input.details}` : '';

  return sendNotificationAttempt({
    db: input.db,
    env: input.env,
    orderId,
    orderNumber,
    type: 'admin_failure_alert',
    recipientEmail: input.env.MAILJET_SENDER_EMAIL,
    recipientName: input.env.MAILJET_SENDER_NAME,
    statusTransition: input.statusTransition,
    source: input.source,
    subject: `Order workflow needs attention: ${input.reason}`,
    text: `Order ${orderNumber}: ${input.reason}.${detail}`,
    variables: {
      orderNumber,
      reason: input.reason,
      details: input.details ?? null,
      source: input.source,
    },
    dedupe: input.dedupe,
    alertOnFailure: false,
  });
}
