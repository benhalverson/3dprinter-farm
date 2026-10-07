import { eq } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { orderEventsTable, ordersTable } from '../db/schema';
import factory from '../factory';
import { slantWebhookSchema, verifySlantWebhook, normalizeSlantWebhook } from '../modules/slantWebhook';
import { recordSlantLifecycle } from '../modules/slantLifecycle';
import {
  alertSlantWebhookFailure,
  tryReconcileSquareNotifications,
} from '../lib/notifications';
import { authMiddleware } from '../utils/authMiddleware';

type OpenAPISchema = Record<string, unknown>;

const slantOrderStatusSchema = z.enum([
  'DRAFT',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELED',
]);

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
  accountId: z.string(),
  id: z.number(),
  orderNumber: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  status: z.string().nullable(),
  slantStatus: z.string().nullable(),
  source: z.string(),
  fulfillmentType: z.string(),
  paymentStatus: z.string().nullable(),
  squareOrderId: z.string().nullable(),
  squarePaymentId: z.string().nullable(),
  shippingAmountCents: z.number().nullable(),
  fulfillmentState: z.string().nullable(),
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
  refund: z.object({status:z.string(),amountCents:z.number().nullable(),currency:z.string().nullable(),refundedAt:z.string().nullable()}).nullable(),
  cancellation: z
    .object({
      canceledAt: z.string().nullable(),
    })
    .nullable(),
});
const customerOrderListSchema = z.object({
  accountId: z.string(),
  orders: z.array(customerOrderSchema),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    count: z.number(),
  }),
});

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
      price:
        typeof record.unitAmountCents === 'number'
          ? record.unitAmountCents / 100
          : typeof record.price === 'number'
            ? record.price
            : null,
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
    source: order.source,
    fulfillmentType: order.fulfillmentType,
    paymentStatus: order.paymentStatus,
    squareOrderId: order.squareOrderId,
    squarePaymentId: order.squarePaymentId,
    shippingAmountCents: order.shippingAmountCents,
    fulfillmentState: order.fulfillmentState,
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
    refund: order.refundStatus ? {status:order.refundStatus,amountCents:order.refundAmountCents,currency:order.currency,refundedAt:order.refundedAt} : null,
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
  .use('/orders', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); })
  .use('/orders/*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); })
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
      const expected = c.req.header('X-Expected-Account-Id');
      if(expected !== undefined && expected !== userId) return c.json({error:'account_changed'},409);

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
        accountId: userId,
        orders: page.map(order => ({...toCustomerOrder(order),accountId:userId})),
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
      const expected = c.req.header('X-Expected-Account-Id');
      if(expected !== undefined && expected !== userId) return c.json({error:'account_changed'},409);

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

      return c.json({...toCustomerOrder(order, events),accountId:userId});
    },
  )
  .post(
    '/webhook/slant3d',
    describeRoute({
      summary: 'Slant3D order status webhook',
      description:
        'Verifies HMAC-SHA256 over timestamp + dot + exact raw body, enforces a five-minute delivery window and platform identity, and records monotonic idempotent lifecycle updates.',
      tags: ['Orders', 'Webhooks', 'Slant3D'],
      parameters: [
        { name: 'X-Webhook-Timestamp', in: 'header', required: true, schema: { type: 'string' }, description: 'Unix delivery timestamp in milliseconds' },
        { name: 'X-Webhook-Signature-256', in: 'header', required: true, schema: { type: 'string' }, description: 'sha256= followed by HMAC-SHA256 hex digest' },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: resolver(
              slantWebhookSchema,
            ) as unknown as OpenAPISchema,
          },
        },
        required: true,
      },
      responses: {
        200: {
          description: 'Webhook processed successfully, or unrelated authenticated event ignored',
          content: {
            'application/json': {
              schema: resolver(
                z.union([webhookSuccessSchema, z.object({ success: z.literal(true), ignored: z.literal(true) })]),
              ) as unknown as OpenAPISchema,
            },
          },
        },
        401: {
          description: 'Invalid, stale, or tampered webhook signature',
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
        409: {
          description:
            'Ambiguous order identity, conflicting event ID reuse, invalid lifecycle transition, or a concurrent lifecycle change. Resolve identity/transition conflicts; retry the unchanged event after a concurrent change.',
          content: {
            'application/json': {
              schema: resolver(webhookErrorSchema) as unknown as OpenAPISchema,
            },
          },
        },
        503: {
          description:
            'Webhook secret is not configured, or lifecycle persistence is unavailable. Missing configuration requires operator action; retry the same event after a persistence failure.',
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
    /** Authenticate before atomically recording manufacturing evidence and recovering email intents. */
    async c => {
      const configuredSecret = c.env.SLANT_WEBHOOK_SECRET;
      if (!configuredSecret || !c.env.SLANT_PLATFORM_ID)
        return c.json({ error: 'Slant webhook configuration required' }, 503);
      const rawBody = await c.req.text();
      if (!await verifySlantWebhook(rawBody, c.req.header('X-Webhook-Timestamp'), c.req.header('X-Webhook-Signature-256'), configuredSecret))
        return c.json({ error: 'Invalid webhook signature' }, 401);
      let input: Awaited<ReturnType<typeof normalizeSlantWebhook>>;
      try {
        const body = slantWebhookSchema.parse(JSON.parse(rawBody));
        if (body.platform_id !== c.env.SLANT_PLATFORM_ID)
          return c.json({ error: 'Invalid webhook platform' }, 401);
        input = await normalizeSlantWebhook(body);
      } catch {
        return c.json({ error: 'Invalid request body' }, 422);
      }
      if (!input) return c.json({ success: true, ignored: true });

      let outcome: Awaited<ReturnType<typeof recordSlantLifecycle>>;
      try {
        outcome = await recordSlantLifecycle(c.var.db, input);
      } catch {
        console.error('notification.slant_webhook_failed');
        await alertSlantWebhookFailure(
          c.var.db,
          c.env,
          input.orderId,
          input.eventId,
        );
        return c.json(
          { error: 'Lifecycle persistence unavailable; retry event' },
          503,
        );
      }
      if (outcome.status !== 200)
        return c.json({ error: outcome.error }, outcome.status);
      await tryReconcileSquareNotifications(c.var.db, c.env, outcome.orderId);
      return c.json({
        success: true,
        orderId: outcome.orderId,
        status: outcome.lifecycleStatus,
      });
    },
  );

export default ordersRouter;
