import { and, eq, like, gte, lte, or } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { ordersTable, orderEventsTable, users } from '../db/schema';
import factory from '../factory';
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

const errorSchema = z.object({ error: z.string() });

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
              schema: resolver(z.object({ orders: z.array(orderListItemSchema) })),
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
      const db = c.var.db;
      const query = c.req.query();

      const conditions = [];

      if (query.status) {
        conditions.push(eq(ordersTable.status, query.status));
      }
      if (query.slantStatus) {
        conditions.push(eq(ordersTable.slantStatus, query.slantStatus));
      }
      if (query.email) {
        conditions.push(eq(ordersTable.customerEmail, query.email));
      }
      if (query.orderNumber) {
        conditions.push(eq(ordersTable.orderNumber, query.orderNumber));
      }
      if (query.slantPublicOrderId) {
        conditions.push(eq(ordersTable.slantPublicOrderId, query.slantPublicOrderId));
      }
      if (query.stripeCheckoutSessionId) {
        conditions.push(eq(ordersTable.stripeCheckoutSessionId, query.stripeCheckoutSessionId));
      }
      if (query.stripePaymentIntentId) {
        conditions.push(eq(ordersTable.stripePaymentIntentId, query.stripePaymentIntentId));
      }
      if (query.createdAfter) {
        conditions.push(gte(ordersTable.createdAt, query.createdAfter));
      }
      if (query.createdBefore) {
        conditions.push(lte(ordersTable.createdAt, query.createdBefore));
      }
      if (query.q) {
        conditions.push(
          or(
            like(ordersTable.customerEmail, `%${query.q}%`),
            like(ordersTable.orderNumber, `%${query.q}%`),
          ),
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const orders = await db
        .select({
          id: ordersTable.id,
          orderNumber: ordersTable.orderNumber,
          userId: ordersTable.userId,
          status: ordersTable.status,
          slantStatus: ordersTable.slantStatus,
          slantPublicOrderId: ordersTable.slantPublicOrderId,
          customerEmail: ordersTable.customerEmail,
          createdAt: ordersTable.createdAt,
        })
        .from(ordersTable)
        .where(whereClause)
        .all();

      return c.json({ orders });
    },
  )
  .get(
    '/admin/orders/:id',
    authMiddleware,
    requireCatalogMutationRole,
    describeRoute({
      description: 'Get detailed order information including events (admin only)',
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
      const db = c.var.db;
      const orderId = Number(c.req.param('id'));

      if (Number.isNaN(orderId)) {
        return c.json({ error: 'Invalid order ID' }, 400);
      }

      const order = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .get();

      if (!order) {
        return c.json({ error: 'Order not found' }, 404);
      }

      const events = await db
        .select()
        .from(orderEventsTable)
        .where(eq(orderEventsTable.orderId, orderId))
        .all();

      return c.json({ ...order, events });
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
      const db = c.var.db;
      const orderId = Number(c.req.param('id'));
      const actor = (c.get('jwtPayload') as { email?: string } | undefined)?.email ?? 'admin';

      if (Number.isNaN(orderId)) {
        return c.json({ error: 'Invalid order ID' }, 400);
      }

      const order = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .get();

      if (!order) {
        return c.json({ error: 'Order not found' }, 404);
      }

      // Block retry for orders already successfully fulfilled
      const successStatuses = new Set(['fulfilled', 'shipped', 'completed']);
      if (order.slantStatus && successStatuses.has(order.slantStatus)) {
        return c.json(
          { error: 'Order already successfully processed. Retry is not allowed.' },
          400,
        );
      }

      // Only allow retry for failed statuses
      const retryEligibleStatuses = new Set(['failed', 'error', 'pending']);
      if (order.status && !retryEligibleStatuses.has(order.status)) {
        return c.json(
          { error: `Order status "${order.status}" is not eligible for retry.` },
          400,
        );
      }

      // Update status to indicate retry in progress
      await db
        .update(ordersTable)
        .set({ status: 'retrying', updatedAt: new Date().toISOString() })
        .where(eq(ordersTable.id, orderId));

      // Record the retry event
      const [event] = await db
        .insert(orderEventsTable)
        .values({
          orderId,
          type: 'retry_initiated',
          detail: `Admin retry initiated by ${actor}`,
          actor,
        })
        .returning();

      return c.json({ success: true, event });
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
      const db = c.var.db;
      const orderId = Number(c.req.param('id'));
      const actor = (c.get('jwtPayload') as { email?: string } | undefined)?.email ?? 'admin';

      if (Number.isNaN(orderId)) {
        return c.json({ error: 'Invalid order ID' }, 400);
      }

      const order = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .get();

      if (!order) {
        return c.json({ error: 'Order not found' }, 404);
      }

      // Record the notification event
      const [event] = await db
        .insert(orderEventsTable)
        .values({
          orderId,
          type: 'notification_resent',
          detail: `Notification resent by ${actor}`,
          actor,
        })
        .returning();

      return c.json({ success: true, event });
    },
  );

export default adminOrders;
