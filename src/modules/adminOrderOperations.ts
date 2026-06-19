import { and, eq, gte, like, lte, or, type SQL } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import { orderEventsTable, ordersTable } from '../db/schema';

type Database = DrizzleD1Database<typeof schema>;

export type AdminOrderListFilters = Partial<{
  status: string;
  slantStatus: string;
  email: string;
  orderNumber: string;
  slantPublicOrderId: string;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string;
  createdAfter: string;
  createdBefore: string;
  q: string;
}>;

export type AdminActor = {
  email?: string | null;
};

export type AdminOrderEvent = typeof orderEventsTable.$inferSelect;

export type AdminOrderListItem = Pick<
  typeof ordersTable.$inferSelect,
  | 'id'
  | 'orderNumber'
  | 'userId'
  | 'status'
  | 'slantStatus'
  | 'slantPublicOrderId'
  | 'customerEmail'
  | 'createdAt'
>;

export type AdminOrderDetail = typeof ordersTable.$inferSelect & {
  events: AdminOrderEvent[];
};

export type OrderLifecycleSnapshot = {
  id: number;
  status: string | null;
  slantStatus: string | null;
};

export type RetryOrderResult =
  | { type: 'retry_started'; event: AdminOrderEvent }
  | { type: 'not_found' }
  | {
      type: 'retry_rejected';
      reason: 'already_processed' | 'status_not_eligible';
      message: string;
    };

export type RecordNotificationResendResult =
  | { type: 'notification_resend_recorded'; event: AdminOrderEvent }
  | { type: 'not_found' };

export interface AdminOrderOperations {
  list(filters?: AdminOrderListFilters): Promise<{
    orders: AdminOrderListItem[];
  }>;
  getDetail(orderId: number): Promise<AdminOrderDetail | null>;
  requestRetry(input: {
    orderId: number;
    actor: AdminActor;
  }): Promise<RetryOrderResult>;
  recordNotificationResend(input: {
    orderId: number;
    actor: AdminActor;
  }): Promise<RecordNotificationResendResult>;
}

export interface AdminOrderReadAdapter {
  list(filters?: AdminOrderListFilters): Promise<AdminOrderListItem[]>;
  getDetail(orderId: number): Promise<AdminOrderDetail | null>;
  getLifecycle(orderId: number): Promise<OrderLifecycleSnapshot | null>;
}

export interface AdminOrderWriteAdapter {
  markRetryingAndAppendEvent(input: {
    orderId: number;
    actor: string;
    detail: string;
    at: string;
  }): Promise<AdminOrderEvent>;
  appendEvent(input: {
    orderId: number;
    type: 'notification_resent';
    actor: string;
    detail: string;
    at: string;
  }): Promise<AdminOrderEvent>;
}

export type AdminOrderOperationsDeps = {
  read: AdminOrderReadAdapter;
  write: AdminOrderWriteAdapter;
  clock?: () => string;
};

const SUCCESSFUL_SLANT_STATUSES = new Set([
  'fulfilled',
  'shipped',
  'completed',
]);
const RETRY_ELIGIBLE_STATUSES = new Set(['failed', 'error', 'pending']);

function defaultClock() {
  return new Date().toISOString();
}

function actorName(actor: AdminActor) {
  return actor.email ?? 'unknown-admin';
}

export function createAdminOrderOperations({
  read,
  write,
  clock = defaultClock,
}: AdminOrderOperationsDeps): AdminOrderOperations {
  return {
    async list(filters) {
      return { orders: await read.list(filters) };
    },

    getDetail(orderId) {
      return read.getDetail(orderId);
    },

    async requestRetry({ orderId, actor }) {
      const order = await read.getLifecycle(orderId);

      if (!order) {
        return { type: 'not_found' };
      }

      if (
        order.slantStatus &&
        SUCCESSFUL_SLANT_STATUSES.has(order.slantStatus)
      ) {
        return {
          type: 'retry_rejected',
          reason: 'already_processed',
          message:
            'Order already successfully processed. Retry is not allowed.',
        };
      }

      if (order.status && !RETRY_ELIGIBLE_STATUSES.has(order.status)) {
        return {
          type: 'retry_rejected',
          reason: 'status_not_eligible',
          message: `Order status "${order.status}" is not eligible for retry.`,
        };
      }

      const actorLabel = actorName(actor);
      const event = await write.markRetryingAndAppendEvent({
        orderId,
        actor: actorLabel,
        detail: `Admin retry initiated by ${actorLabel}`,
        at: clock(),
      });

      return { type: 'retry_started', event };
    },

    async recordNotificationResend({ orderId, actor }) {
      const order = await read.getLifecycle(orderId);

      if (!order) {
        return { type: 'not_found' };
      }

      const actorLabel = actorName(actor);
      const event = await write.appendEvent({
        orderId,
        type: 'notification_resent',
        actor: actorLabel,
        detail: `Notification resent by ${actorLabel}`,
        at: clock(),
      });

      return { type: 'notification_resend_recorded', event };
    },
  };
}

export function adminOrderOperationsForDb(db: Database) {
  return createAdminOrderOperations({
    read: createDrizzleAdminOrderReadAdapter(db),
    write: createDrizzleAdminOrderWriteAdapter(db),
  });
}

function createDrizzleAdminOrderReadAdapter(
  db: Database,
): AdminOrderReadAdapter {
  return {
    async list(filters = {}) {
      const conditions = buildListConditions(filters);
      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      return db
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
    },

    async getDetail(orderId) {
      const order = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .get();

      if (!order) {
        return null;
      }

      const events = await db
        .select()
        .from(orderEventsTable)
        .where(eq(orderEventsTable.orderId, orderId))
        .all();

      return { ...order, events };
    },

    getLifecycle(orderId) {
      return db
        .select({
          id: ordersTable.id,
          status: ordersTable.status,
          slantStatus: ordersTable.slantStatus,
        })
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .get();
    },
  };
}

function createDrizzleAdminOrderWriteAdapter(
  db: Database,
): AdminOrderWriteAdapter {
  return {
    async markRetryingAndAppendEvent({ orderId, actor, detail, at }) {
      await db
        .update(ordersTable)
        .set({ status: 'retrying', updatedAt: at })
        .where(eq(ordersTable.id, orderId));

      const [event] = await db
        .insert(orderEventsTable)
        .values({
          orderId,
          type: 'retry_initiated',
          detail,
          actor,
          createdAt: at,
        })
        .returning();

      return event as AdminOrderEvent;
    },

    async appendEvent({ orderId, type, actor, detail, at }) {
      const [event] = await db
        .insert(orderEventsTable)
        .values({
          orderId,
          type,
          detail,
          actor,
          createdAt: at,
        })
        .returning();

      return event as AdminOrderEvent;
    },
  };
}

function buildListConditions(filters: AdminOrderListFilters) {
  const conditions: SQL[] = [];

  if (filters.status) {
    conditions.push(eq(ordersTable.status, filters.status));
  }
  if (filters.slantStatus) {
    conditions.push(eq(ordersTable.slantStatus, filters.slantStatus));
  }
  if (filters.email) {
    conditions.push(eq(ordersTable.customerEmail, filters.email));
  }
  if (filters.orderNumber) {
    conditions.push(eq(ordersTable.orderNumber, filters.orderNumber));
  }
  if (filters.slantPublicOrderId) {
    conditions.push(
      eq(ordersTable.slantPublicOrderId, filters.slantPublicOrderId),
    );
  }
  if (filters.stripeCheckoutSessionId) {
    conditions.push(
      eq(ordersTable.stripeCheckoutSessionId, filters.stripeCheckoutSessionId),
    );
  }
  if (filters.stripePaymentIntentId) {
    conditions.push(
      eq(ordersTable.stripePaymentIntentId, filters.stripePaymentIntentId),
    );
  }
  if (filters.createdAfter) {
    conditions.push(gte(ordersTable.createdAt, filters.createdAfter));
  }
  if (filters.createdBefore) {
    conditions.push(lte(ordersTable.createdAt, filters.createdBefore));
  }
  if (filters.q) {
    const searchCondition = or(
      like(ordersTable.customerEmail, `%${filters.q}%`),
      like(ordersTable.orderNumber, `%${filters.q}%`),
    );

    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  return conditions;
}
