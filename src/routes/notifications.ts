import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { notificationAttempts } from '../db/schema';
import factory from '../factory';
import {
  getFailedNotifications,
  getNotificationsByOrderId,
  resendNotification,
} from '../lib/notifications';
import { authMiddleware, requireCatalogMutationRole } from '../utils/authMiddleware';

const notificationsRouter = factory
  .createApp()
  .use('/notifications/*', authMiddleware)
  .use('/notifications/*', requireCatalogMutationRole)
  .get(
    '/notifications/order/:orderId',
    describeRoute({
      description:
        'Get all notification attempts for a specific order. Requires admin role.',
      tags: ['Notifications'],
      responses: {
        200: {
          description: 'List of notification attempts for the order',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  notifications: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'number' },
                        orderId: { type: 'string' },
                        notificationType: { type: 'string' },
                        recipientEmail: { type: 'string' },
                        status: { type: 'string' },
                        providerMessageId: { type: 'string', nullable: true },
                        errorMessage: { type: 'string', nullable: true },
                        createdAt: { type: 'string' },
                        sentAt: { type: 'string', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        401: {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const orderId = c.req.param('orderId');
      const db = c.var.db;

      const notifications = await getNotificationsByOrderId(db, orderId);
      return c.json({ notifications });
    },
  )
  .get(
    '/notifications/failed',
    describeRoute({
      description:
        'Get all failed notification attempts. Requires admin role.',
      tags: ['Notifications'],
      responses: {
        200: {
          description: 'List of failed notification attempts',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  notifications: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'number' },
                        orderId: { type: 'string' },
                        notificationType: { type: 'string' },
                        recipientEmail: { type: 'string' },
                        status: { type: 'string' },
                        errorMessage: { type: 'string', nullable: true },
                        createdAt: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const db = c.var.db;
      const notifications = await getFailedNotifications(db);
      return c.json({ notifications });
    },
  )
  .post(
    '/notifications/resend/:id',
    describeRoute({
      description:
        'Resend a failed or pending notification by ID. Requires admin role. Will not resend already-sent notifications.',
      tags: ['Notifications'],
      responses: {
        200: {
          description: 'Notification resend result',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  status: { type: 'string' },
                  providerMessageId: { type: 'string', nullable: true },
                  error: { type: 'string', nullable: true },
                  skipped: { type: 'boolean' },
                },
              },
            },
          },
        },
        400: {
          description: 'Invalid notification ID',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        404: {
          description: 'Notification not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const idParam = c.req.param('id');
      const id = Number(idParam);

      if (!id || Number.isNaN(id)) {
        return c.json({ error: 'Invalid notification ID' }, 400);
      }

      const db = c.var.db;
      const result = await resendNotification(db, c.env, id);

      if (result.error === 'Notification not found') {
        return c.json({ error: 'Notification not found' }, 404);
      }

      return c.json(result);
    },
  );

export default notificationsRouter;
