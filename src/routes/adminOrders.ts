import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import factory from '../factory';
import { adminOrderOperationsForDb } from '../modules/adminOrderOperations';
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

function parseOrderId(value: string) {
  const orderId = Number(value);
  return Number.isNaN(orderId) ? null : orderId;
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

      return c.json({ success: true, event: result.event });
    },
  );

export default adminOrders;
