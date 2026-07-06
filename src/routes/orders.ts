import { and, eq } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { orderEventsTable, ordersTable } from '../db/schema';
import factory from '../factory';
import {
  notificationTypeForSlantStatus,
  sendAdminFailureAlert,
  sendOrderNotification,
} from '../modules/orderNotifications';
import { authMiddleware } from '../utils/authMiddleware';

type OpenAPISchema = Record<string, unknown>;

const slantOrderStatusSchema = z.enum([
  'DRAFT',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELED',
]);

const slantWebhookBodySchema = z.object({
  eventId: z.string().optional(),
  orderId: z.string(),
  status: slantOrderStatusSchema,
  metadata: z.record(z.unknown()).optional(),
});

const webhookSuccessSchema = z.object({
  success: z.boolean(),
  orderId: z.number(),
  status: slantOrderStatusSchema,
});

const webhookErrorSchema = z.object({ error: z.string() });
const orderItemSchema = z.object({
  skuNumber: z.string().nullable(),
  name: z.string().nullable(),
  quantity: z.number(),
  color: z.string().nullable(),
  filamentType: z.string().nullable(),
  image: z.string().nullable(),
  price: z.number().nullable(),
});
const customerOrderSchema = z.object({
  id: z.number(),
  orderNumber: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  status: z.string().nullable(),
  slantStatus: z.string().nullable(),
  totalAmountCents: z.number().nullable(),
  currency: z.string().nullable(),
  items: z.array(orderItemSchema),
  fulfillment: z.object({
    slantPublicOrderId: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    trackingUrl: z.string().nullable(),
    carrier: z.string().nullable(),
    estimatedArrival: z.string().nullable(),
    shippedAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
  }),
  cancellation: z
    .object({
      canceledAt: z.string().nullable(),
    })
    .nullable(),
});
const customerOrderListSchema = z.object({
  orders: z.array(customerOrderSchema),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    count: z.number(),
  }),
});

function localStatusForSlantStatus(
  status: z.infer<typeof slantOrderStatusSchema>,
) {
  return status.toLowerCase();
}

function timestampFieldForStatus(
  status: z.infer<typeof slantOrderStatusSchema>,
) {
  if (status === 'PROCESSING') return 'processedAt';
  if (status === 'SHIPPED') return 'shippedAt';
  if (status === 'DELIVERED') return 'deliveredAt';
  if (status === 'CANCELED') return 'canceledAt';
  return null;
}

function responseStatusForOrder(
  value: string | null | undefined,
  fallback: z.infer<typeof slantOrderStatusSchema>,
) {
  const parsed = slantOrderStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

async function alertSlantWebhookFailure(input: {
  c: {
    var: { db: Parameters<typeof sendAdminFailureAlert>[0]['db'] };
    env: Parameters<typeof sendAdminFailureAlert>[0]['env'];
  };
  order?: Partial<OrderRow> | null;
  statusTransition: string;
  reason: string;
  details?: string | null;
}) {
  try {
    await sendAdminFailureAlert({
      db: input.c.var.db,
      env: input.c.env,
      order: input.order,
      source: 'slant3d',
      statusTransition: input.statusTransition,
      reason: input.reason,
      details: input.details,
    });
  } catch (error) {
    console.error('Failed to send Slant3D webhook admin alert:', error);
  }
}

type OrderRow = typeof ordersTable.$inferSelect;
type OrderEventRow = typeof orderEventsTable.$inferSelect;

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseOrderId(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseJsonObject(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function safeOrderItems(value: string | null | undefined) {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) return [];

  return parsed.map(item => {
    const record = item as Record<string, unknown>;
    return {
      skuNumber: typeof record.skuNumber === 'string' ? record.skuNumber : null,
      name: typeof record.name === 'string' ? record.name : null,
      quantity: typeof record.quantity === 'number' ? record.quantity : 0,
      color: typeof record.color === 'string' ? record.color : null,
      filamentType:
        typeof record.filamentType === 'string' ? record.filamentType : null,
      image: typeof record.image === 'string' ? record.image : null,
      price: typeof record.price === 'number' ? record.price : null,
    };
  });
}

function trackingFromEvents(events: OrderEventRow[]) {
  for (const event of [...events].reverse()) {
    const metadata = parseJsonObject(event.metadata);
    if (!metadata) continue;

    const record = metadata as Record<string, unknown>;
    const trackingNumber =
      typeof record.trackingNumber === 'string'
        ? record.trackingNumber
        : typeof record.tracking_number === 'string'
          ? record.tracking_number
          : null;
    const trackingUrl =
      typeof record.trackingUrl === 'string'
        ? record.trackingUrl
        : typeof record.tracking_url === 'string'
          ? record.tracking_url
          : null;
    const carrier = typeof record.carrier === 'string' ? record.carrier : null;
    const estimatedArrival =
      typeof record.estimatedArrival === 'string'
        ? record.estimatedArrival
        : typeof record.estimated_arrival === 'string'
          ? record.estimated_arrival
          : null;

    if (trackingNumber || trackingUrl || carrier || estimatedArrival) {
      return { trackingNumber, trackingUrl, carrier, estimatedArrival };
    }
  }

  return {
    trackingNumber: null,
    trackingUrl: null,
    carrier: null,
    estimatedArrival: null,
  };
}

function toCustomerOrder(order: OrderRow, events: OrderEventRow[] = []) {
  const tracking = trackingFromEvents(events);

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    slantStatus: order.slantStatus,
    totalAmountCents: order.totalAmountCents,
    currency: order.currency,
    items: safeOrderItems(order.itemSnapshot),
    fulfillment: {
      slantPublicOrderId: order.slantPublicOrderId,
      trackingNumber: tracking.trackingNumber,
      trackingUrl: tracking.trackingUrl,
      carrier: tracking.carrier,
      estimatedArrival: tracking.estimatedArrival,
      shippedAt: order.shippedAt,
      deliveredAt: order.deliveredAt,
    },
    cancellation: order.canceledAt ? { canceledAt: order.canceledAt } : null,
  };
}

function sortAndPaginateCustomerOrders(
  orders: OrderRow[],
  limit: number,
  offset: number,
  direction: 'asc' | 'desc',
) {
  const sorted = [...orders].sort((a, b) => {
    const aTime = Date.parse(a.createdAt ?? '') || 0;
    const bTime = Date.parse(b.createdAt ?? '') || 0;
    return direction === 'asc' ? aTime - bTime : bTime - aTime;
  });

  return sorted.slice(offset, offset + limit);
}

const ordersRouter = factory
  .createApp()
  .get(
    '/orders',
    authMiddleware,
    describeRoute({
      summary: 'List customer orders',
      description:
        'Returns the authenticated customer order history with safe buyer-facing fields only.',
      tags: ['Orders'],
      parameters: [
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100 },
        },
        {
          name: 'offset',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 0 },
        },
        {
          name: 'direction',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['asc', 'desc'] },
        },
      ],
      responses: {
        200: {
          description: 'Customer order history',
          content: {
            'application/json': {
              schema: resolver(
                customerOrderListSchema,
              ) as unknown as OpenAPISchema,
            },
          },
        },
        401: {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: resolver(webhookErrorSchema) as unknown as OpenAPISchema,
            },
          },
        },
      },
    }),
    async c => {
      const userId = c.get('userId');
      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const limit = Math.min(
        Math.max(parsePositiveInteger(c.req.query('limit'), 20), 1),
        100,
      );
      const offset = parsePositiveInteger(c.req.query('offset'), 0);
      const direction = c.req.query('direction') === 'asc' ? 'asc' : 'desc';

      const rows = await c.var.db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.userId, userId))
        .all();
      const page = sortAndPaginateCustomerOrders(
        rows as OrderRow[],
        limit,
        offset,
        direction,
      );

      return c.json({
        orders: page.map(order => toCustomerOrder(order)),
        pagination: {
          limit,
          offset,
          count: rows.length,
        },
      });
    },
  )
  .get(
    '/orders/:id',
    authMiddleware,
    describeRoute({
      summary: 'Get customer order detail',
      description:
        'Returns one authenticated customer order if it belongs to the current user.',
      tags: ['Orders'],
      responses: {
        200: {
          description: 'Customer order detail',
          content: {
            'application/json': {
              schema: resolver(customerOrderSchema) as unknown as OpenAPISchema,
            },
          },
        },
        400: {
          description: 'Invalid order ID',
          content: {
            'application/json': {
              schema: resolver(webhookErrorSchema) as unknown as OpenAPISchema,
            },
          },
        },
        401: {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: resolver(webhookErrorSchema) as unknown as OpenAPISchema,
            },
          },
        },
        403: {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: resolver(webhookErrorSchema) as unknown as OpenAPISchema,
            },
          },
        },
        404: {
          description: 'Order not found',
          content: {
            'application/json': {
              schema: resolver(webhookErrorSchema) as unknown as OpenAPISchema,
            },
          },
        },
      },
    }),
    async c => {
      const userId = c.get('userId');
      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const orderId = parseOrderId(c.req.param('id'));
      if (orderId === null) {
        return c.json({ error: 'Invalid order ID' }, 400);
      }

      const order = (await c.var.db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .get()) as OrderRow | undefined;

      if (!order) {
        return c.json({ error: 'Order not found' }, 404);
      }

      if (order.userId !== userId) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      const events = (await c.var.db
        .select()
        .from(orderEventsTable)
        .where(eq(orderEventsTable.orderId, order.id))
        .all()) as OrderEventRow[];

      return c.json(toCustomerOrder(order, events));
    },
  )
  .post(
    '/webhook/slant3d',
    describeRoute({
      summary: 'Slant3D order status webhook',
      description:
        'Receives Slant3D platform order status updates and applies them idempotently to local order lifecycle records.',
      tags: ['Orders', 'Webhooks', 'Slant3D'],
      requestBody: {
        content: {
          'application/json': {
            schema: resolver(
              slantWebhookBodySchema,
            ) as unknown as OpenAPISchema,
          },
        },
        required: true,
      },
      responses: {
        200: {
          description: 'Webhook processed successfully',
          content: {
            'application/json': {
              schema: resolver(
                webhookSuccessSchema,
              ) as unknown as OpenAPISchema,
            },
          },
        },
        401: {
          description: 'Invalid webhook secret',
          content: {
            'application/json': {
              schema: resolver(webhookErrorSchema) as unknown as OpenAPISchema,
            },
          },
        },
        404: {
          description: 'Order not found',
          content: {
            'application/json': {
              schema: resolver(webhookErrorSchema) as unknown as OpenAPISchema,
            },
          },
        },
        422: {
          description: 'Invalid request body',
          content: {
            'application/json': {
              schema: resolver(webhookErrorSchema) as unknown as OpenAPISchema,
            },
          },
        },
      },
    }),
    async c => {
      const configuredSecret = c.env.SLANT_WEBHOOK_SECRET;
      if (configuredSecret) {
        const headerSecret = c.req.header('x-slant-webhook-secret');
        if (headerSecret !== configuredSecret) {
          return c.json({ error: 'Invalid webhook secret' }, 401);
        }
      }

      let jsonParseFailed = false;
      const rawBody = await c.req.json().catch(async error => {
        jsonParseFailed = true;
        await alertSlantWebhookFailure({
          c,
          statusTransition: 'slant_webhook_invalid_json',
          reason: 'Slant3D webhook body could not be parsed as JSON',
          details: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      const parsed = slantWebhookBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        if (!jsonParseFailed) {
          await alertSlantWebhookFailure({
            c,
            statusTransition: 'slant_webhook_invalid_body',
            reason: 'Slant3D webhook payload failed validation',
            details: parsed.error.message,
          });
        }
        return c.json({ error: 'Invalid request body' }, 422);
      }

      const { eventId, orderId, status, metadata } = parsed.data;
      const order = await c.var.db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.slantPublicOrderId, orderId))
        .get();

      if (!order) {
        await alertSlantWebhookFailure({
          c,
          statusTransition: 'slant_webhook_unknown_order',
          reason: 'Slant3D webhook referenced an unknown local order',
          details: `Slant order ${orderId}, event ${eventId ?? 'missing-event-id'}`,
        });
        return c.json({ error: 'Order not found' }, 404);
      }

      if (eventId) {
        const existingEvent = await c.var.db
          .select()
          .from(orderEventsTable)
          .where(
            and(
              eq(orderEventsTable.orderId, order.id),
              eq(orderEventsTable.externalEventId, eventId),
            ),
          )
          .get();

        if (existingEvent) {
          return c.json({
            success: true,
            orderId: order.id,
            status: responseStatusForOrder(order.slantStatus, status),
          });
        }
      }

      const now = new Date().toISOString();
      const previousStatus = order.slantStatus ?? order.status ?? null;
      const updateFields: Partial<typeof ordersTable.$inferInsert> = {
        status: localStatusForSlantStatus(status),
        slantStatus: status,
        updatedAt: now,
      };
      const timestampField = timestampFieldForStatus(status);
      if (timestampField === 'processedAt') updateFields.processedAt = now;
      if (timestampField === 'shippedAt') updateFields.shippedAt = now;
      if (timestampField === 'deliveredAt') updateFields.deliveredAt = now;
      if (timestampField === 'canceledAt') updateFields.canceledAt = now;

      await c.var.db
        .update(ordersTable)
        .set(updateFields)
        .where(eq(ordersTable.id, order.id));

      await c.var.db.insert(orderEventsTable).values({
        orderId: order.id,
        type: 'slant_status_changed',
        detail: `Slant3D status changed from ${previousStatus ?? 'unknown'} to ${status}`,
        actor: 'slant3d',
        externalEventId: eventId ?? null,
        source: 'slant3d',
        previousStatus,
        nextStatus: status,
        metadata: metadata ? JSON.stringify(metadata) : null,
        createdAt: now,
      });

      const notificationType = notificationTypeForSlantStatus(status);
      if (notificationType) {
        try {
          await sendOrderNotification({
            db: c.var.db,
            env: c.env,
            order: {
              id: order.id,
              orderNumber: order.orderNumber,
              customerEmail: order.customerEmail,
              status: updateFields.status ?? order.status,
              slantStatus: status,
            },
            type: notificationType,
            source: 'slant3d',
            statusTransition: `${previousStatus ?? 'unknown'}_to_${status}`,
          });
        } catch (error) {
          console.error('Slant3D webhook notification handling failed:', error);
          await alertSlantWebhookFailure({
            c,
            order,
            statusTransition: 'slant_webhook_notification_failed',
            reason:
              'Slant3D webhook status was applied but notification handling failed',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return c.json({
        success: true,
        orderId: order.id,
        status,
      });
    },
  );

export default ordersRouter;
