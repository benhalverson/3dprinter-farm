import { and, eq } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { orderEventsTable, ordersV2Table } from '../db/schema';
import factory from '../factory';

type OpenAPISchema = Record<string, unknown>;

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const slantWebhookBodySchema = z.object({
  eventId: z.string().optional(),
  orderId: z.string(),
  status: z.enum(['DRAFT', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELED']),
  metadata: z.record(z.unknown()).optional(),
});

export type SlantWebhookBody = z.infer<typeof slantWebhookBodySchema>;

const webhookSuccessSchema = z.object({
  success: z.boolean(),
  orderId: z.string(),
  status: z.string(),
});

const webhookErrorSchema = z.object({
  error: z.string(),
});

// ─── Router ───────────────────────────────────────────────────────────────────

const ordersRouter = factory
  .createApp()
  .post(
    '/webhook/slant3d',
    describeRoute({
      summary: 'Slant3D order status webhook',
      description:
        'Receives order status updates from Slant3D platform. Verifies webhook authenticity via X-Slant-Webhook-Secret header when SLANT_WEBHOOK_SECRET is configured. Handles idempotent event processing.',
      tags: ['Orders', 'Webhooks', 'Slant3D'],
      requestBody: {
        content: {
          'application/json': {
            schema: resolver(slantWebhookBodySchema) as unknown as OpenAPISchema,
          },
        },
        required: true,
      },
      responses: {
        200: {
          description: 'Webhook processed successfully',
          content: {
            'application/json': {
              schema: resolver(webhookSuccessSchema) as unknown as OpenAPISchema,
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
      // 1. Verify webhook authenticity
      const configuredSecret = c.env.SLANT_WEBHOOK_SECRET;
      if (configuredSecret) {
        const headerSecret = c.req.header('x-slant-webhook-secret');
        if (headerSecret !== configuredSecret) {
          return c.json({ error: 'Invalid webhook secret' }, 401);
        }
      }

      // 2. Parse and validate body
      const rawBody = await c.req.json();
      const parsed = slantWebhookBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body' }, 422);
      }

      const { eventId, orderId, status, metadata } = parsed.data;
      const db = c.var.db;

      // 3. Find the local order by slantPublicOrderId
      const order = await db
        .select()
        .from(ordersV2Table)
        .where(eq(ordersV2Table.slantPublicOrderId, orderId))
        .get();

      if (!order) {
        return c.json({ error: 'Order not found' }, 404);
      }

      // 4. Idempotency check: if eventId already exists in events, acknowledge
      if (eventId) {
        const existing = await db
          .select()
          .from(orderEventsTable)
          .where(
            and(
              eq(orderEventsTable.orderId, order.id),
              eq(orderEventsTable.externalEventId, eventId),
            ),
          )
          .get();

        if (existing) {
          return c.json({
            success: true,
            orderId: order.id,
            status: order.localStatus,
          });
        }
      }

      // 5. Update local order status
      const previousStatus = order.localStatus;
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);

      const updateFields: Record<string, unknown> = {
        localStatus: status,
        slantStatus: status,
        updatedAt: now,
      };

      if (status === 'PROCESSING') updateFields.processedAt = now;
      if (status === 'SHIPPED') updateFields.shippedAt = now;
      if (status === 'DELIVERED') updateFields.deliveredAt = now;
      if (status === 'CANCELED') updateFields.canceledAt = now;

      await db
        .update(ordersV2Table)
        .set(updateFields)
        .where(eq(ordersV2Table.id, order.id));

      // 6. Record event
      await db.insert(orderEventsTable).values({
        orderId: order.id,
        externalEventId: eventId || null,
        source: 'slant3d',
        previousStatus,
        nextStatus: status,
        metadata: metadata ? JSON.stringify(metadata) : null,
      });

      return c.json({
        success: true,
        orderId: order.id,
        status,
      });
    },
  );

export default ordersRouter;
