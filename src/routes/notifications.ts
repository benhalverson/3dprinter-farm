import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { orderNotificationAttemptsTable as attempts } from '../db/schema';
import factory from '../factory';
import {
  deliverNotification,
  reconcileSquareNotifications,
} from '../lib/notifications';
import {
  authMiddleware,
  requireCatalogMutationRole,
} from '../utils/authMiddleware';

const rowSchema = z.object({
  id: z.number(),
  orderId: z.number().nullable(),
  notificationType: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const errorSchema = z.object({ error: z.string() });
const deliverySchema = z.object({
  id: z.number(),
  status: z.string(),
  providerMessageId: z.string().nullable(),
});
const summary = {
  id: attempts.id,
  orderId: attempts.orderId,
  notificationType: attempts.notificationType,
  status: attempts.status,
  createdAt: attempts.createdAt,
  updatedAt: attempts.updatedAt,
};

/** Accept whole positive safe integers, never partial numeric path values. */
function parseId(value: string) {
  const id = Number(value);
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(id) ? id : null;
}

/** Describe bounded admin queries without disclosing email envelopes. */
function listDocs(description: string) {
  return describeRoute({
    description,
    tags: ['Notifications'],
    responses: {
      200: {
        description: 'Up to 100 newest attempts',
        content: {
          'application/json': {
            schema: resolver(z.object({ notifications: z.array(rowSchema) })),
          },
        },
      },
      400: {
        description: 'Invalid ID',
        content: { 'application/json': { schema: resolver(errorSchema) } },
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' },
      500: { description: 'Notification query failed' },
    },
  });
}

const notifications = factory
  .createApp()
  .use(
    '/notifications/*',
    /** Prevent DB/provider error payloads reaching request logs. */ async (
      c,
      next,
    ) => {
      c.header('Cache-Control', 'no-store');
      try {
        await next();
      } catch {
        console.error('notification.request_failed');
        return c.json({ error: 'Notification request failed' }, 500);
      }
    },
  )
  .use('/notifications/*', authMiddleware, requireCatalogMutationRole)
  .get(
    '/notifications/order/:orderId',
    listDocs('List notification attempts for an order (admin/owner only)'),
    /** Read a bounded status-only audit list. */ async c => {
      const id = parseId(c.req.param('orderId'));
      if (id === null) return c.json({ error: 'Invalid order ID' }, 400);
      const rows = await c.var.db
        .select(summary)
        .from(attempts)
        .where(eq(attempts.orderId, id))
        .orderBy(desc(attempts.id))
        .limit(100);
      return c.json({ notifications: rows });
    },
  )
  .get(
    '/notifications/failed',
    listDocs(
      'List retryable and ambiguous deliveries (admin/owner only); sending/unknown require reconciliation',
    ),
    /** Include ambiguous claims without authorizing a resend. */ async c => {
      const rows = await c.var.db
        .select(summary)
        .from(attempts)
        .where(
          and(
            isNotNull(attempts.deliveryKey),
            inArray(attempts.status, [
              'pending',
              'failed',
              'sending',
              'unknown',
            ]),
          ),
        )
        .orderBy(desc(attempts.id))
        .limit(100);
      return c.json({ notifications: rows });
    },
  )
  .post(
    '/notifications/order/:orderId/reconcile',
    describeRoute({
      description:
        'Recover notifications from persisted verified Square evidence only (admin/owner). Does not call payment or fulfillment providers; sending requires explicit enablement.',
      tags: ['Notifications'],
      responses: {
        200: {
          description:
            'Persisted Square evidence reconciled; emails remain disabled unless explicitly enabled',
        },
        400: { description: 'Invalid order ID' },
        401: { description: 'Unauthorized' },
        403: { description: 'Forbidden' },
        409: { description: 'No verified Square evidence' },
        500: { description: 'Reconciliation incomplete; retry the same order' },
      },
    }),
    /** Replay trusted evidence after a missed producer invocation without accepting event/recipient input. */ async c => {
      const orderId = parseId(c.req.param('orderId'));
      if (orderId === null) return c.json({ error: 'Invalid order ID' }, 400);
      const outcome = await reconcileSquareNotifications(
        c.var.db,
        c.env,
        orderId,
      );
      return c.json(outcome, outcome.verified ? 200 : 409);
    },
  )
  .post(
    '/notifications/resend/:id',
    describeRoute({
      description:
        'Deliver a pending or pre-provider failed attempt using its original envelope (admin/owner only). Ambiguous and legacy attempts cannot be resent.',
      tags: ['Notifications'],
      responses: {
        200: {
          description: 'Provider accepted (not proof of inbox delivery)',
          content: { 'application/json': { schema: resolver(deliverySchema) } },
        },
        400: { description: 'Invalid ID' },
        401: { description: 'Unauthorized' },
        403: { description: 'Forbidden' },
        404: { description: 'Attempt not found' },
        409: {
          description: 'Attempt requires reconciliation or configuration',
          content: { 'application/json': { schema: resolver(deliverySchema) } },
        },
        500: { description: 'Notification request failed' },
      },
    }),
    /** Retry only the persisted attempt; request bodies cannot change recipients/content. */ async c => {
      const id = parseId(c.req.param('id'));
      if (id === null) return c.json({ error: 'Invalid notification ID' }, 400);
      const outcome = await deliverNotification(c.var.db, c.env, id);
      if (!outcome) return c.json({ error: 'Notification not found' }, 404);
      return c.json(outcome, outcome.status === 'sent' ? 200 : 409);
    },
  );

export default notifications;
