import { reconcileSquareOrder } from '../modules/squareOrderReconciliation';
import {clearCartLines} from '../modules/cartMutations';
import { refundInput, refundSale } from '../modules/squareRefunds';
import { eq } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { createPaidOrderFulfillment } from '../modules/paidOrderFulfillment';
import { z } from 'zod';
import { BASE_URL_V2 } from '../constants';
import {
  cart,
  squareRefundOperations,
  orderEventsTable,
  orderReconciliationAttemptsTable,
  ordersTable,
} from '../db/schema';
import factory from '../factory';
import { tryReconcileSquareNotifications } from '../lib/notifications';
import { adminOrderOperationsForDb } from '../modules/adminOrderOperations';
import {
  authMiddleware,
  requireCatalogMutationRole,
} from '../utils/authMiddleware';

// --- Zod schemas for OpenAPI docs ---

const orderListItemSchema = z.object({
  id: z.number(),
  orderNumber: z.string(),
  userId: z.string().nullable(),
  source: z.string(),
  fulfillmentType: z.string(),
  paymentStatus: z.string().nullable(),
  squareOrderId: z.string().nullable(),
  squarePaymentId: z.string().nullable(),
  fulfillmentState: z.string().nullable(),
  status: z.string().nullable(),
  slantStatus: z.string().nullable(),
  slantPublicOrderId: z.string().nullable(),
  customerEmail: z.string().nullable(),
  createdAt: z.string().nullable(),
});

const orderDetailSchema = z.object({
  id: z.number(),
  orderNumber: z.string(),
  userId: z.string().nullable(),
  filename: z.string().nullable(),
  fileURL: z.string().nullable(),
  status: z.string().nullable(),
  slantStatus: z.string().nullable(),
  slantPublicOrderId: z.string().nullable(),
  source: z.string(),
  fulfillmentType: z.string(),
  paymentStatus: z.string().nullable(),
  squareOrderId: z.string().nullable(),
  squarePaymentId: z.string().nullable(),
  checkoutAttemptId: z.string().nullable(),
  totalAmountCents: z.number().nullable(),
  currency: z.string().nullable(),
  itemSnapshot: z.string().nullable(),
  refundStatus: z.string().nullable(),
  refundAmountCents: z.number().nullable(),
  refundedAt: z.string().nullable(),
  shippingAmountCents: z.number().nullable(),
  fulfillmentState: z.string().nullable(),
  customerEmail: z.string().nullable(),
  shipToName: z.string().nullable(),
  shipToStreet1: z.string().nullable(),
  shipToStreet2: z.string().nullable(),
  shipToCity: z.string().nullable(),
  shipToState: z.string().nullable(),
  shipToZip: z.string().nullable(),
  shipToCountryISO: z.string().nullable(),
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

/**
 * Shared response for legacy and Square admin reconciliation. resultStatus keeps
 * the existing fulfillment meaning; the optional audit fields identify a Square
 * attempt and its diagnostic outcome without changing legacy callers' contract.
 */
const reconcileResponseSchema = z.object({
  success: z.boolean(),
  orderId: z.number(),
  attemptId: z.number().optional(),
  reconciliationStatus: z.enum(['no_action', 'reported', 'recovered']).optional(),
  resultStatus: z.string(),
  detectedIssues: z.array(z.string()),
  actionsTaken: z.array(z.string()),
  recommendedAction: z.string().nullable(),
  localStatus: z.string().nullable(),
  slantStatus: z.string().nullable(),
});

const errorSchema = z.object({ error: z.string() });

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
    squareOrderId: order.squareOrderId,
    squarePaymentId: order.squarePaymentId,
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
        'Retry eligible fulfillment. Square orders permit only ready/drafted stages, return success/orderId, and reject ambiguous or completed stages with409; reconcile first.',
      tags: ['Admin Orders'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: resolver(
                z.union([
                  z.object({ success: z.boolean(), event: orderEventSchema }),
                  z.object({ success: z.boolean(), orderId: z.number() }),
                ]),
              ),
            },
          },
          description: 'Retry initiated',
        },
        400: {
          content: { 'application/json': { schema: resolver(errorSchema) } },
          description: 'Retry not allowed',
        },
        409: {
          description:
            'Square fulfillment is completed or uncertain; reconcile before retry',
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
    /** Run authorized order recovery, then reconcile only persisted Square notification evidence. */
    async c => {
      const orderId = parseOrderId(c.req.param('id'));

      if (orderId === null) {
        return c.json({ error: 'Invalid order ID' }, 400);
      }

      const [paid] = await c.var.db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId));
      if (paid?.squarePaymentId) {
        if (!['ready', 'drafted'].includes(paid.fulfillmentState || ''))
          return c.json(
            {
              error:
                'Reconcile uncertain fulfillment before retry; no external effect was repeated',
            },
            409,
          );
        await createPaidOrderFulfillment({
          db: c.var.db,
          env: c.env,
        }).fulfillPaidOrder(orderId);
        await tryReconcileSquareNotifications(c.var.db, c.env, orderId);
        return c.json({ success: true, orderId });
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
    describeRoute({description:'Request or reconcile one durable full Square refund under the existing cancellation/override policy.',tags:['Admin Orders'],responses:{200:{description:'Refund state; success is true only when completed'},400:{description:'Ineligible order or invalid input'},409:{description:'Reconciliation or explicit override required'},401:{description:'Unauthorized'},403:{description:'Forbidden'}}}),
    async c => {
      const orderId=parseOrderId(c.req.param('id'));
      const actorId=c.var.jwtPayload?.id;
      if(orderId===null)return c.json({error:'Invalid order ID'},400);
      if(!actorId)return c.json({error:'Unauthorized'},401);
      const input=refundInput.safeParse(await c.req.json().catch(()=>({})));
      if(!input.success)return c.json({error:'Invalid request body'},400);
      return c.json(await refundSale(c.var.db,c.env,orderId,actorId,input.data));
    },
  )
  .post(
    '/admin/orders/:id/reconcile',
    authMiddleware,
    requireCatalogMutationRole,
    describeRoute({
      description:
        'Reconcile a local order with Slant3D (admin only). For Square, optionally supply slantPublicOrderId to recover a lost draft ID; retrieved checkout/payment metadata must match. Attempts and diagnostics are persisted, processed orders refresh lifecycle status monotonically, and ambiguous process is read-only and never re-manufactured.',
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slantPublicOrderId: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
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
    /** Run authorized order recovery, then reconcile only persisted Square notification evidence. */
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

      if (order.fulfillmentState === 'refund_hold') {
        const [operation] = await c.var.db.select().from(squareRefundOperations).where(eq(squareRefundOperations.orderId,order.id));
        if(operation) return c.json(await refundSale(c.var.db,c.env,order.id,c.var.jwtPayload!.id!,{reason:operation.reason??undefined,override:operation.override}));
      }
      if (order.squarePaymentId || order.fulfillmentType === 'in_person') {
        const recovery = z.object({ slantPublicOrderId: z.string().min(1).optional() })
          .strict().safeParse(await c.req.json().catch(() => ({})));
        if (!recovery.success) return c.json({ error: 'Invalid recovery input' }, 400);
        return c.json(await reconcileSquareOrder(c.var.db, c.env, order, recovery.data.slantPublicOrderId));
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
        await clearCartLines(c.var.db,order.cartId??'',eq(cart.cartId,order.cartId??''));
        actionsTaken.push('cleared_cart');
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
  );

export default adminOrders;
