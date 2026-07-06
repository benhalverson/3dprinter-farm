import { eq } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import Stripe from 'stripe';
import { z } from 'zod';
import { createSchema } from 'zod-openapi';
import { BASE_URL_V2 } from '../constants';
import {
  cart,
  orderCancellationAttemptsTable,
  orderEventsTable,
  orderReconciliationAttemptsTable,
  ordersTable,
} from '../db/schema';
import factory from '../factory';
import { adminOrderOperationsForDb } from '../modules/adminOrderOperations';
import {
  notificationTypeForSlantStatus,
  sendAdminFailureAlert,
  sendOrderNotification,
} from '../modules/orderNotifications';
import {
  authMiddleware,
  requireCatalogMutationRole,
} from '../utils/authMiddleware';

// --- Zod schemas for OpenAPI docs ---

const orderListItemSchema = z.object({
  id: z.number(),
  orderNumber: z.string(),
  userId: z.string(),
  status: z.string().nullable(),
  slantStatus: z.string().nullable(),
  slantPublicOrderId: z.string().nullable(),
  customerEmail: z.string().nullable(),
  createdAt: z.string().nullable(),
});

const orderDetailSchema = z.object({
  id: z.number(),
  orderNumber: z.string(),
  userId: z.string(),
  filename: z.string().nullable(),
  fileURL: z.string(),
  status: z.string().nullable(),
  slantStatus: z.string().nullable(),
  slantPublicOrderId: z.string().nullable(),
  stripeCheckoutSessionId: z.string().nullable(),
  stripePaymentIntentId: z.string().nullable(),
  customerEmail: z.string().nullable(),
  shipToName: z.string(),
  shipToStreet1: z.string(),
  shipToStreet2: z.string().nullable(),
  shipToCity: z.string(),
  shipToState: z.string(),
  shipToZip: z.string(),
  shipToCountryISO: z.string(),
  billToStreet1: z.string().nullable(),
  billToStreet2: z.string().nullable(),
  billToCity: z.string().nullable(),
  billToState: z.string().nullable(),
  billToZip: z.string().nullable(),
  billToCountryISO: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  events: z.array(
    z.object({
      id: z.number(),
      type: z.string(),
      detail: z.string().nullable(),
      actor: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

const orderEventSchema = z.object({
  id: z.number(),
  type: z.string(),
  detail: z.string().nullable(),
  actor: z.string().nullable(),
  createdAt: z.string(),
});

const cancelRefundRequestSchema = z.object({
  reason: z.string().max(500).optional(),
  override: z.boolean().optional(),
});

const cancelRefundResponseSchema = z.object({
  success: z.boolean(),
  duplicate: z.boolean().optional(),
  orderId: z.number(),
  status: z.string(),
  slantStatus: z.string().nullable(),
  stripeRefundId: z.string().nullable(),
  stripeRefundStatus: z.string().nullable(),
});

const reconcileResponseSchema = z.object({
  success: z.boolean(),
  orderId: z.number(),
  resultStatus: z.string(),
  detectedIssues: z.array(z.string()),
  actionsTaken: z.array(z.string()),
  recommendedAction: z.string().nullable(),
  localStatus: z.string().nullable(),
  slantStatus: z.string().nullable(),
});

const errorSchema = z.object({ error: z.string() });

type DescribeRouteConfig = Parameters<typeof describeRoute>[0];
type RequestBodySchema = NonNullable<
  NonNullable<
    Extract<
      NonNullable<DescribeRouteConfig['requestBody']>,
      { content?: Record<string, { schema?: unknown }> }
    >['content']
  >[string]['schema']
>;
type OpenApiSchema = RequestBodySchema;

function openApiInputSchema(schema: z.ZodTypeAny): OpenApiSchema {
  return createSchema(schema, {
    openapi: '3.1.0',
    schemaType: 'input',
  }).schema as unknown as OpenApiSchema;
}

const INELIGIBLE_REFUND_STATUSES = new Set([
  'shipped',
  'delivered',
  'SHIPPED',
  'DELIVERED',
]);
const SLANT_TERMINAL_OR_ACTIVE_STATUSES = new Set([
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELED',
]);

function parseOrderId(value: string) {
  const orderId = Number(value);
  return Number.isNaN(orderId) ? null : orderId;
}

function getAdminActor(c: { get: (key: string) => unknown }) {
  const payload = c.get('jwtPayload') as
    | { id?: string; email?: string }
    | undefined;
  return {
    id: payload?.id ?? null,
    email: payload?.email ?? null,
    label: payload?.email ?? payload?.id ?? 'unknown-admin',
  };
}

function requiresRefundOverride(order: typeof ordersTable.$inferSelect) {
  return (
    (order.status && INELIGIBLE_REFUND_STATUSES.has(order.status)) ||
    (order.slantStatus && INELIGIBLE_REFUND_STATUSES.has(order.slantStatus))
  );
}

function serializeUnknown(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function readResponseBody(response: Response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function localStatusForSlantStatus(status: string) {
  if (status === 'SHIPPED') return 'shipped';
  if (status === 'DELIVERED') return 'delivered';
  if (status === 'CANCELED') return 'canceled';
  if (status === 'PROCESSING') return 'processing';
  return 'pending';
}

function timestampUpdateForSlantStatus(status: string, at: string) {
  if (status === 'SHIPPED') return { shippedAt: at };
  if (status === 'DELIVERED') return { deliveredAt: at };
  if (status === 'CANCELED') return { canceledAt: at };
  if (status === 'PROCESSING') return { processedAt: at };
  return {};
}

function extractSlantOrderStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;

  const order = payload as {
    status?: string;
    slantStatus?: string;
    data?: {
      status?: string;
      slantStatus?: string;
      order?: { status?: string };
    };
    order?: { status?: string; slantStatus?: string };
  };

  return (
    order.status ??
    order.slantStatus ??
    order.data?.status ??
    order.data?.slantStatus ??
    order.data?.order?.status ??
    order.order?.status ??
    order.order?.slantStatus ??
    null
  );
}

function orderStartingState(order: typeof ordersTable.$inferSelect) {
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    slantStatus: order.slantStatus,
    slantPublicOrderId: order.slantPublicOrderId,
    stripeCheckoutSessionId: order.stripeCheckoutSessionId,
    stripePaymentIntentId: order.stripePaymentIntentId,
    cartId: order.cartId,
    hasItemSnapshot: Boolean(order.itemSnapshot),
    hasCustomerSnapshot: Boolean(order.customerSnapshot),
  };
}

type ReconciliationWriteDb = {
  insert: (table: typeof orderReconciliationAttemptsTable) => {
    values: (
      payload: typeof orderReconciliationAttemptsTable.$inferInsert,
    ) => Promise<unknown> | unknown;
  };
};

async function recordReconciliationAttempt(input: {
  db: ReconciliationWriteDb;
  order: typeof ordersTable.$inferSelect;
  triggerSource: string;
  detectedIssues: string[];
  actionsTaken: string[];
  resultStatus: string;
  errorMessage?: string | null;
  at: string;
}) {
  await input.db.insert(orderReconciliationAttemptsTable).values({
    orderId: input.order.id,
    triggerSource: input.triggerSource,
    startingState: JSON.stringify(orderStartingState(input.order)),
    detectedIssueType: input.detectedIssues.length
      ? JSON.stringify(input.detectedIssues)
      : null,
    actionsTaken: input.actionsTaken.length
      ? JSON.stringify(input.actionsTaken)
      : null,
    resultStatus: input.resultStatus,
    errorMessage: input.errorMessage ?? null,
    createdAt: input.at,
    updatedAt: input.at,
  });
}

// --- Route ---

const adminOrders = factory
  .createApp()
  .get(
    '/admin/orders',
    authMiddleware,
    requireCatalogMutationRole,
    describeRoute({
      description: 'List and filter orders (admin only)',
      tags: ['Admin Orders'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: resolver(
                z.object({ orders: z.array(orderListItemSchema) }),
              ),
            },
          },
          description: 'Order list',
        },
        401: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Unauthorized',
        },
        403: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Forbidden',
        },
      },
    }),
    async c => {
      const operations = adminOrderOperationsForDb(c.var.db);
      const result = await operations.list(c.req.query());

      return c.json(result);
    },
  )
  .get(
    '/admin/orders/:id',
    authMiddleware,
    requireCatalogMutationRole,
    describeRoute({
      description:
        'Get detailed order information including events (admin only)',
      tags: ['Admin Orders'],
      responses: {
        200: {
          content: {
            'application/json': { schema: resolver(orderDetailSchema) },
          },
          description: 'Order detail',
        },
        401: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Unauthorized',
        },
        403: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Forbidden',
        },
        404: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Order not found',
        },
      },
    }),
    async c => {
      const orderId = parseOrderId(c.req.param('id'));

      if (orderId === null) {
        return c.json({ error: 'Invalid order ID' }, 400);
      }

      const operations = adminOrderOperationsForDb(c.var.db);
      const order = await operations.getDetail(orderId);

      if (!order) {
        return c.json({ error: 'Order not found' }, 404);
      }

      return c.json(order);
    },
  )
  .post(
    '/admin/orders/:id/retry',
    authMiddleware,
    requireCatalogMutationRole,
    describeRoute({
      description:
        'Retry a failed Slant submission for an order. Blocked if already successfully processed.',
      tags: ['Admin Orders'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: resolver(
                z.object({ success: z.boolean(), event: orderEventSchema }),
              ),
            },
          },
          description: 'Retry initiated',
        },
        400: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Retry not allowed',
        },
        401: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Unauthorized',
        },
        403: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Forbidden',
        },
        404: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Order not found',
        },
      },
    }),
    async c => {
      const orderId = parseOrderId(c.req.param('id'));

      if (orderId === null) {
        return c.json({ error: 'Invalid order ID' }, 400);
      }

      const operations = adminOrderOperationsForDb(c.var.db);
      const result = await operations.requestRetry({
        orderId,
        actor: {
          email: (c.get('jwtPayload') as { email?: string } | undefined)?.email,
        },
      });

      if (result.type === 'not_found') {
        return c.json({ error: 'Order not found' }, 404);
      }

      if (result.type === 'retry_rejected') {
        return c.json({ error: result.message }, 400);
      }

      return c.json({ success: true, event: result.event });
    },
  )
  .post(
    '/admin/orders/:id/cancel-refund',
    authMiddleware,
    requireCatalogMutationRole,
    describeRoute({
      description:
        'Cancel an eligible Slant3D order and refund the Stripe payment (admin only)',
      tags: ['Admin Orders'],
      requestBody: {
        content: {
          'application/json': {
            schema: openApiInputSchema(cancelRefundRequestSchema),
          },
        },
        required: false,
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: resolver(cancelRefundResponseSchema),
            },
          },
          description: 'Order canceled and refunded',
        },
        400: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Cancellation/refund is not allowed',
        },
        401: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Unauthorized',
        },
        403: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Forbidden',
        },
        404: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Order not found',
        },
        502: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Slant3D or Stripe refund failed',
        },
      },
    }),
    async c => {
      const orderId = parseOrderId(c.req.param('id'));

      if (orderId === null) {
        return c.json({ error: 'Invalid order ID' }, 400);
      }

      const body = await c.req.json().catch(() => ({}));
      const parsed = cancelRefundRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body' }, 400);
      }

      const order = await c.var.db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .get();

      if (!order) {
        return c.json({ error: 'Order not found' }, 404);
      }

      const actor = getAdminActor(c);
      const now = new Date().toISOString();
      const attempts = await c.var.db
        .select()
        .from(orderCancellationAttemptsTable)
        .where(eq(orderCancellationAttemptsTable.orderId, order.id))
        .all();
      const successfulAttempt = attempts.find(
        attempt =>
          attempt.stripeRefundId ||
          attempt.finalStatus === 'refunded' ||
          attempt.finalStatus === 'canceled_refunded',
      );

      if (successfulAttempt) {
        return c.json({
          success: true,
          duplicate: true,
          orderId: order.id,
          status: order.status ?? 'canceled',
          slantStatus: order.slantStatus,
          stripeRefundId: successfulAttempt.stripeRefundId,
          stripeRefundStatus: successfulAttempt.stripeRefundStatus,
        });
      }

      const override = parsed.data.override ?? false;
      if (requiresRefundOverride(order) && !override) {
        await c.var.db.insert(orderCancellationAttemptsTable).values({
          orderId: order.id,
          actorId: actor.id,
          actorEmail: actor.email,
          reason: parsed.data.reason ?? null,
          override,
          slantStatus: order.slantStatus,
          finalStatus: 'blocked_ineligible_status',
          errorMessage:
            'Order has shipped or delivered and requires override to cancel/refund.',
          createdAt: now,
          updatedAt: now,
        });

        return c.json(
          {
            error:
              'Order has shipped or delivered and requires override to cancel/refund.',
          },
          400,
        );
      }

      if (!order.stripePaymentIntentId) {
        await c.var.db.insert(orderCancellationAttemptsTable).values({
          orderId: order.id,
          actorId: actor.id,
          actorEmail: actor.email,
          reason: parsed.data.reason ?? null,
          override,
          slantStatus: order.slantStatus,
          finalStatus: 'missing_stripe_payment_intent',
          errorMessage: 'Order is missing Stripe payment intent ID.',
          createdAt: now,
          updatedAt: now,
        });

        return c.json(
          { error: 'Order is missing Stripe payment intent ID.' },
          400,
        );
      }

      let slantStatus = order.slantPublicOrderId
        ? 'not_attempted'
        : 'skipped_no_slant_order_id';
      let slantResult: string | null = null;

      if (order.slantPublicOrderId) {
        const slantResponse = await fetch(
          `${BASE_URL_V2}orders/${order.slantPublicOrderId}`,
          {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${c.env.SLANT_API_V2}`,
            },
          },
        );
        slantResult = serializeUnknown(await readResponseBody(slantResponse));
        slantStatus = slantResponse.ok ? 'canceled' : 'failed';

        if (!slantResponse.ok && !override) {
          await c.var.db.insert(orderCancellationAttemptsTable).values({
            orderId: order.id,
            actorId: actor.id,
            actorEmail: actor.email,
            reason: parsed.data.reason ?? null,
            override,
            slantStatus,
            slantResult,
            finalStatus: 'slant_cancellation_failed',
            errorMessage: `Slant3D cancellation failed with ${slantResponse.status}`,
            createdAt: now,
            updatedAt: now,
          });

          return c.json(
            { error: 'Slant3D cancellation failed; Stripe was not refunded.' },
            502,
          );
        }
      }

      const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { telemetry: false });
      let refund: Stripe.Refund;

      try {
        refund = await stripe.refunds.create(
          {
            payment_intent: order.stripePaymentIntentId,
            reason: 'requested_by_customer',
            metadata: {
              orderId: String(order.id),
              orderNumber: order.orderNumber,
              actorId: actor.id ?? '',
            },
          },
          {
            idempotencyKey: `order-${order.id}-cancel-refund`,
          },
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Stripe refund failed';
        await c.var.db.insert(orderCancellationAttemptsTable).values({
          orderId: order.id,
          actorId: actor.id,
          actorEmail: actor.email,
          reason: parsed.data.reason ?? null,
          override,
          slantStatus,
          slantResult,
          finalStatus: 'stripe_refund_failed',
          errorMessage,
          createdAt: now,
          updatedAt: now,
        });

        await sendAdminFailureAlert({
          db: c.var.db,
          env: c.env,
          order,
          source: 'admin',
          statusTransition: 'cancel_refund_stripe_refund_failed',
          reason: 'Stripe refund failed during admin cancel/refund',
          details: errorMessage,
        });

        return c.json({ error: 'Stripe refund failed.' }, 502);
      }

      await c.var.db.insert(orderCancellationAttemptsTable).values({
        orderId: order.id,
        actorId: actor.id,
        actorEmail: actor.email,
        reason: parsed.data.reason ?? null,
        override,
        slantStatus,
        slantResult,
        stripeRefundId: refund.id,
        stripeRefundStatus: refund.status ?? null,
        stripeResult: serializeUnknown(refund),
        finalStatus: 'canceled_refunded',
        createdAt: now,
        updatedAt: now,
      });

      await c.var.db
        .update(ordersTable)
        .set({
          status: 'canceled',
          slantStatus: 'CANCELED',
          canceledAt: now,
          updatedAt: now,
        })
        .where(eq(ordersTable.id, order.id));

      await c.var.db.insert(orderEventsTable).values({
        orderId: order.id,
        type: 'admin_cancel_refund',
        detail: `Order canceled/refunded by ${actor.label}`,
        actor: actor.label,
        source: 'admin',
        previousStatus: order.status,
        nextStatus: 'canceled',
        metadata: JSON.stringify({
          reason: parsed.data.reason ?? null,
          override,
          stripeRefundId: refund.id,
          stripeRefundStatus: refund.status,
          slantStatus,
        }),
        createdAt: now,
      });

      await sendOrderNotification({
        db: c.var.db,
        env: c.env,
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          customerEmail: order.customerEmail,
          status: 'canceled',
          slantStatus: 'CANCELED',
        },
        type: 'order_canceled',
        source: 'admin',
        statusTransition: `${order.status ?? 'unknown'}_to_canceled`,
        reason: parsed.data.reason ?? null,
      });

      return c.json({
        success: true,
        orderId: order.id,
        status: 'canceled',
        slantStatus: 'CANCELED',
        stripeRefundId: refund.id,
        stripeRefundStatus: refund.status ?? null,
      });
    },
  )
  .post(
    '/admin/orders/:id/reconcile',
    authMiddleware,
    requireCatalogMutationRole,
    describeRoute({
      description:
        'Reconcile a local order with Slant3D and recover safe fulfillment drift (admin only)',
      tags: ['Admin Orders'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: resolver(reconcileResponseSchema),
            },
          },
          description: 'Reconciliation completed',
        },
        400: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Invalid order ID',
        },
        401: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Unauthorized',
        },
        403: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Forbidden',
        },
        404: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Order not found',
        },
        502: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Slant3D lookup failed',
        },
      },
    }),
    async c => {
      const orderId = parseOrderId(c.req.param('id'));

      if (orderId === null) {
        return c.json({ error: 'Invalid order ID' }, 400);
      }

      const order = await c.var.db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .get();

      if (!order) {
        return c.json({ error: 'Order not found' }, 404);
      }

      const detectedIssues: string[] = [];
      const actionsTaken: string[] = [];
      const now = new Date().toISOString();
      let resultStatus = 'no_action';
      let recommendedAction: string | null = null;
      let currentSlantStatus = order.slantStatus;

      if (!order.itemSnapshot) detectedIssues.push('missing_item_snapshot');
      if (!order.customerSnapshot) {
        detectedIssues.push('missing_customer_snapshot');
      }

      const cartRows = order.cartId
        ? await c.var.db
            .select()
            .from(cart)
            .where(eq(cart.cartId, order.cartId))
        : [];
      const cartStillHasItems = Array.isArray(cartRows) && cartRows.length > 0;

      if (
        cartStillHasItems &&
        order.slantStatus &&
        SLANT_TERMINAL_OR_ACTIVE_STATUSES.has(order.slantStatus)
      ) {
        detectedIssues.push('cart_not_cleared_after_fulfillment');
        await c.var.db.delete(cart).where(eq(cart.cartId, order.cartId ?? ''));
        actionsTaken.push('cleared_cart');
      }

      const hasStripePayment = Boolean(
        order.stripePaymentIntentId || order.stripeCheckoutSessionId,
      );
      if (hasStripePayment && !order.slantPublicOrderId) {
        detectedIssues.push('paid_without_slant_order_id');
        resultStatus = 'needs_admin_action';
        recommendedAction = 'Use admin retry fulfillment or cancel/refund.';

        await recordReconciliationAttempt({
          db: c.var.db,
          order,
          triggerSource: 'admin',
          detectedIssues,
          actionsTaken,
          resultStatus,
          at: now,
        });
        await sendAdminFailureAlert({
          db: c.var.db,
          env: c.env,
          order,
          source: 'admin',
          statusTransition: 'reconciliation_paid_without_slant_order',
          reason: 'Paid order is missing a Slant3D order id',
          details: `Order ${order.orderNumber}`,
        });

        return c.json({
          success: true,
          orderId: order.id,
          resultStatus,
          detectedIssues,
          actionsTaken,
          recommendedAction,
          localStatus: order.status,
          slantStatus: currentSlantStatus,
        });
      }

      if (order.slantPublicOrderId) {
        const slantResponse = await fetch(
          `${BASE_URL_V2}orders/${order.slantPublicOrderId}`,
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${c.env.SLANT_API_V2}`,
            },
          },
        );

        if (!slantResponse.ok) {
          const errorMessage = `Slant3D lookup failed with ${slantResponse.status}`;
          detectedIssues.push('slant_lookup_failed');
          resultStatus = 'failed';
          recommendedAction = 'Retry reconciliation later or inspect Slant3D.';

          await recordReconciliationAttempt({
            db: c.var.db,
            order,
            triggerSource: 'admin',
            detectedIssues,
            actionsTaken,
            resultStatus,
            errorMessage,
            at: now,
          });
          await sendAdminFailureAlert({
            db: c.var.db,
            env: c.env,
            order,
            source: 'admin',
            statusTransition: 'reconciliation_slant_lookup_failed',
            reason: 'Slant3D reconciliation lookup failed',
            details: errorMessage,
          });

          return c.json({ error: 'Slant3D lookup failed.' }, 502);
        }

        const slantPayload = await readResponseBody(slantResponse);
        const slantStatus = extractSlantOrderStatus(slantPayload);
        if (!slantStatus) {
          const errorMessage = 'Slant3D lookup response did not include status';
          detectedIssues.push('slant_lookup_missing_status');
          resultStatus = 'failed';
          recommendedAction = 'Inspect the Slant3D order response.';

          await recordReconciliationAttempt({
            db: c.var.db,
            order,
            triggerSource: 'admin',
            detectedIssues,
            actionsTaken,
            resultStatus,
            errorMessage,
            at: now,
          });

          return c.json({ error: 'Slant3D lookup missing status.' }, 502);
        }

        currentSlantStatus = slantStatus;
        if (slantStatus !== order.slantStatus) {
          detectedIssues.push('local_status_stale');
          const nextLocalStatus = localStatusForSlantStatus(slantStatus);
          await c.var.db
            .update(ordersTable)
            .set({
              status: nextLocalStatus,
              slantStatus,
              updatedAt: now,
              ...timestampUpdateForSlantStatus(slantStatus, now),
            })
            .where(eq(ordersTable.id, order.id));
          await c.var.db.insert(orderEventsTable).values({
            orderId: order.id,
            type: 'reconciliation_status_updated',
            detail: `Reconciliation updated Slant3D status from ${order.slantStatus ?? 'unknown'} to ${slantStatus}`,
            actor: 'admin',
            source: 'admin',
            previousStatus: order.slantStatus,
            nextStatus: slantStatus,
            metadata: JSON.stringify({
              slantPublicOrderId: order.slantPublicOrderId,
            }),
            createdAt: now,
          });
          actionsTaken.push('updated_local_status');

          const notificationType = notificationTypeForSlantStatus(slantStatus);
          if (notificationType) {
            await sendOrderNotification({
              db: c.var.db,
              env: c.env,
              order: {
                id: order.id,
                orderNumber: order.orderNumber,
                customerEmail: order.customerEmail,
                status: nextLocalStatus,
                slantStatus,
              },
              type: notificationType,
              source: 'admin',
              statusTransition: `${order.slantStatus ?? 'unknown'}_to_${slantStatus}`,
            });
          }
        }
      }

      if (detectedIssues.length > 0 || actionsTaken.length > 0) {
        resultStatus = actionsTaken.length > 0 ? 'recovered' : 'reported';
        recommendedAction =
          actionsTaken.length > 0 ? null : 'Review the detected order issues.';
      }

      await recordReconciliationAttempt({
        db: c.var.db,
        order,
        triggerSource: 'admin',
        detectedIssues,
        actionsTaken,
        resultStatus,
        at: now,
      });

      return c.json({
        success: true,
        orderId: order.id,
        resultStatus,
        detectedIssues,
        actionsTaken,
        recommendedAction,
        localStatus:
          actionsTaken.includes('updated_local_status') && currentSlantStatus
            ? localStatusForSlantStatus(currentSlantStatus)
            : order.status,
        slantStatus: currentSlantStatus,
      });
    },
  )
  .post(
    '/admin/orders/:id/resend-notification',
    authMiddleware,
    requireCatalogMutationRole,
    describeRoute({
      description: 'Resend order notification email (admin only)',
      tags: ['Admin Orders'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: resolver(
                z.object({ success: z.boolean(), event: orderEventSchema }),
              ),
            },
          },
          description: 'Notification resent',
        },
        401: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Unauthorized',
        },
        403: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Forbidden',
        },
        404: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Order not found',
        },
      },
    }),
    async c => {
      const orderId = parseOrderId(c.req.param('id'));

      if (orderId === null) {
        return c.json({ error: 'Invalid order ID' }, 400);
      }

      const operations = adminOrderOperationsForDb(c.var.db);
      const result = await operations.recordNotificationResend({
        orderId,
        actor: {
          email: (c.get('jwtPayload') as { email?: string } | undefined)?.email,
        },
      });

      if (result.type === 'not_found') {
        return c.json({ error: 'Order not found' }, 404);
      }

      const order = await c.var.db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .get();

      if (order) {
        await sendOrderNotification({
          db: c.var.db,
          env: c.env,
          order,
          type: 'order_confirmation',
          source: 'admin',
          statusTransition: `admin_resend:${result.event.id}`,
          dedupe: false,
        });
      }

      return c.json({ success: true, event: result.event });
    },
  );

export default adminOrders;
