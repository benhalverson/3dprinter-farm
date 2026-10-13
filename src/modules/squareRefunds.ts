import { and, eq, ne } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  squareRefundOperations,
  ordersTable,
  orderEventsTable,
} from '../db/schema';
import type { WorkerEnv } from '../factory';
import { squareClient, squareConfig, isSquareFailure } from '../lib/square';
import { slantV2Url } from '../constants';
import {
  tryReconcileSquareNotifications,
  enqueueAdminFailure,
  deliverNotification,
} from '../lib/notifications';
type Database = WorkerEnv['Variables']['db'];
type Environment = WorkerEnv['Bindings'];
export const refundInput = z
  .object({
    reason: z.string().max(500).optional(),
    override: z.boolean().optional(),
  })
  .strict();
const externalOrder = z.object({
  data: z.object({
    order: z.object({
      publicId: z.string(),
      status: z.string(),
      metadata: z.object({ externalOrderId: z.string() }).optional(),
    }),
  }),
});
export function refundResponse(op: typeof squareRefundOperations.$inferSelect) {
  return {
    orderId: op.orderId,
    operationId: op.id,
    state: op.state,
    squareRefundId: op.refundId,
    error: op.error,
    success: op.state === 'completed',
  };
}
/** One durable full-refund identity per sale; uncertain requests are recovered with the same payload/key. */
export async function refundSale(
  db: Database,
  env: Environment,
  orderId: number,
  actorId: string,
  input: z.infer<typeof refundInput>,
) {
  const config = squareConfig(env);
  const provider = squareClient(config);
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId));
  if (!order) throw new HTTPException(404, { message: 'Order not found' });
  let [op] = await db
    .select()
    .from(squareRefundOperations)
    .where(eq(squareRefundOperations.orderId, orderId));
  if (!op) {
    if (
      !order.squarePaymentId ||
      order.paymentStatus !== 'paid' ||
      !order.totalAmountCents ||
      order.totalAmountCents <= 0 ||
      order.currency?.toUpperCase() !== 'USD'
    )
      throw new HTTPException(400, {
        message: 'Verified refundable Square payment required',
      });
    if (
      [order.slantStatus, order.status].some(status =>
        ['SHIPPED', 'DELIVERED'].includes((status || '').toUpperCase()),
      ) &&
      !input.override
    )
      throw new HTTPException(400, {
        message: 'Shipped or delivered orders require explicit override',
      });
    if (
      order.fulfillmentType === 'slant' &&
      ['drafting', 'processing', 'draft_unknown', 'process_unknown'].includes(
        order.fulfillmentState || '',
      )
    )
      throw new HTTPException(409, {
        message: 'Reconcile uncertain manufacturing before refunding',
      });
    const id = crypto.randomUUID();
    await db
      .insert(squareRefundOperations)
      .values({
        id,
        orderId,
        paymentId: order.squarePaymentId,
        merchantId: config.SQUARE_MERCHANT_ID,
        locationId: config.SQUARE_LOCATION_ID,
        environment: config.SQUARE_ENVIRONMENT,
        amountCents: order.totalAmountCents,
        fulfillmentBefore: order.fulfillmentState || '',
        reason: input.reason ?? null,
        override: input.override ?? false,
        actorId,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .returning();
    [op] = await db
      .select()
      .from(squareRefundOperations)
      .where(eq(squareRefundOperations.orderId, orderId));
  }
  if (op.reason !== (input.reason ?? null))
    throw new HTTPException(409, { message: 'Refund reason already bound' });
  if (['preparing', 'blocked'].includes(op.state)) {
    if (
      order.fulfillmentType === 'slant' &&
      ['drafting', 'processing', 'draft_unknown', 'process_unknown'].includes(
        order.fulfillmentState || '',
      )
    )
      throw new HTTPException(409, {
        message: 'Reconcile uncertain manufacturing before refunding',
      });
    if (order.fulfillmentState !== 'refund_hold') {
      const held = await db
        .update(ordersTable)
        .set({ fulfillmentState: 'refund_hold' })
        .where(
          and(
            eq(ordersTable.id, orderId),
            eq(ordersTable.paymentStatus, 'paid'),
            eq(ordersTable.fulfillmentState, order.fulfillmentState || ''),
          ),
        )
        .returning();
      if (!held.length) return refundResponse(op);
    }
    const before =
      order.fulfillmentState === 'refund_hold'
        ? op.fulfillmentBefore
        : order.fulfillmentState;
    await db
      .update(squareRefundOperations)
      .set({
        state:
          order.fulfillmentType === 'in_person' ||
          (!order.slantPublicOrderId && before === 'ready')
            ? 'ready'
            : 'cancel_pending',
        error: null,
      })
      .where(
        and(
          eq(squareRefundOperations.id, op.id),
          eq(squareRefundOperations.state, op.state),
        ),
      );
    await db
      .insert(orderEventsTable)
      .values({
        orderId,
        type: 'square_refund_requested',
        dedupeKey: `refund-request:${op.id}`,
        actor: actorId,
        detail: op.reason,
      })
      .onConflictDoNothing();
    [op] = await db
      .select()
      .from(squareRefundOperations)
      .where(eq(squareRefundOperations.id, op.id));
  }
  if (
    op.merchantId !== config.SQUARE_MERCHANT_ID ||
    op.locationId !== config.SQUARE_LOCATION_ID ||
    op.environment !== config.SQUARE_ENVIRONMENT
  )
    throw new HTTPException(409, {
      message: 'Refund seller configuration changed',
    });
  if (op.state === 'completed') return refundResponse(op);
  if (['preparing', 'blocked'].includes(op.state)) return refundResponse(op);
  if (op.reason !== (input.reason ?? null))
    throw new HTTPException(409, { message: 'Refund reason already bound' });
  if (
    input.override &&
    !op.override &&
    ['cancel_pending', 'cancel_unknown'].includes(op.state)
  ) {
    await db
      .update(squareRefundOperations)
      .set({ override: true, state: 'ready', error: null })
      .where(
        and(
          eq(squareRefundOperations.id, op.id),
          ne(squareRefundOperations.state, 'completed'),
        ),
      );
    op = { ...op, override: true, state: 'ready' };
    await db.insert(orderEventsTable).values({
      orderId,
      type: 'refund_override',
      actor: actorId,
      detail: 'Explicit override of unresolved manufacturing cancellation',
    });
  }
  try {
    await provider.validateLocation();
    const payment = await provider.retrievePayment(op.paymentId);
    if (
      payment.status !== 'COMPLETED' ||
      payment.order_id !== order.squareOrderId ||
      payment.location_id !== op.locationId ||
      payment.total_money.currency !== 'USD' ||
      payment.total_money.amount !== op.amountCents
    )
      throw new HTTPException(409, {
        message: 'Refund payment evidence mismatch',
      });
    if (op.state === 'cancel_pending' || op.state === 'cancel_unknown') {
      if (!order.slantPublicOrderId)
        throw new HTTPException(409, {
          message: 'Known manufacturing identity required',
        });
      const url = slantV2Url(
        env,
        `orders/${encodeURIComponent(order.slantPublicOrderId)}`,
      );
      const headers = { Authorization: `Bearer ${env.SLANT_API_V2}` };
      if (!env.SLANT_API_V2)
        throw new HTTPException(503, {
          message: 'Manufacturing configuration unavailable',
        });
      let canceled = false;
      if (op.state === 'cancel_unknown') {
        const read = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (read.ok) {
          const evidence = externalOrder.parse(await read.json()).data.order;
          canceled =
            evidence.publicId === order.slantPublicOrderId &&
            evidence.metadata?.externalOrderId === order.orderNumber &&
            evidence.status === 'CANCELED';
        }
      } else {
        const claimed = await db
          .update(squareRefundOperations)
          .set({
            state: 'cancel_unknown',
            error: 'cancellation_outcome_unknown',
          })
          .where(
            and(
              eq(squareRefundOperations.id, op.id),
              eq(squareRefundOperations.state, 'cancel_pending'),
            ),
          )
          .returning();
        if (!claimed.length)
          return refundResponse(
            (
              await db
                .select()
                .from(squareRefundOperations)
                .where(eq(squareRefundOperations.id, op.id))
            )[0],
          );
        const response = await fetch(url, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(10000),
        });
        canceled = response.ok;
        await response.body?.cancel();
      }
      if (!canceled && !op.override)
        return refundResponse(
          (
            await db
              .select()
              .from(squareRefundOperations)
              .where(eq(squareRefundOperations.id, op.id))
          )[0],
        );
      if (canceled)
        await db
          .update(ordersTable)
          .set({
            status: 'canceled',
            slantStatus: 'CANCELED',
            canceledAt: new Date().toISOString(),
          })
          .where(eq(ordersTable.id, orderId));
      await db
        .update(squareRefundOperations)
        .set({ state: 'ready', error: null })
        .where(
          and(
            eq(squareRefundOperations.id, op.id),
            ne(squareRefundOperations.state, 'completed'),
          ),
        );
      op = { ...op, state: 'ready' };
    }
    // A recorded refund is reconciled by ID. A lost response replays the exact same key and payload.
    if (
      order.fulfillmentType === 'slant' &&
      !order.slantPublicOrderId &&
      op.fulfillmentBefore === 'ready'
    )
      await db
        .update(ordersTable)
        .set({ status: 'canceled', canceledAt: new Date().toISOString() })
        .where(eq(ordersTable.id, orderId));
    if (!op.refundId)
      await db
        .update(squareRefundOperations)
        .set({ state: 'unknown', error: 'refund_outcome_unknown' })
        .where(
          and(
            eq(squareRefundOperations.id, op.id),
            ne(squareRefundOperations.state, 'completed'),
          ),
        );
    const refund = op.refundId
      ? await provider.retrieveRefund(op.refundId)
      : await provider.refundPayment({
          idempotency_key: op.id,
          payment_id: op.paymentId,
          amount_money: { amount: op.amountCents, currency: 'USD' },
          ...(op.reason ? { reason: op.reason.slice(0, 192) } : {}),
        });
    if (
      refund.payment_id !== op.paymentId ||
      refund.location_id !== op.locationId ||
      refund.amount_money.currency !== 'USD' ||
      refund.amount_money.amount !== op.amountCents
    )
      throw new HTTPException(502, { message: 'Refund association mismatch' });
    const state =
      refund.status === 'COMPLETED'
        ? 'completed'
        : refund.status === 'PENDING'
          ? 'pending'
          : 'failed';
    await db
      .update(squareRefundOperations)
      .set({
        state,
        refundId: refund.id,
        error:
          state === 'failed'
            ? `square_refund_${refund.status.toLowerCase()}`
            : null,
      })
      .where(
        and(
          eq(squareRefundOperations.id, op.id),
          ne(squareRefundOperations.state, 'completed'),
        ),
      );
    await db
      .update(ordersTable)
      .set({
        refundStatus: state,
        refundAmountCents: op.amountCents,
        ...(state === 'completed'
          ? { refundedAt: new Date().toISOString() }
          : {}),
      })
      .where(
        and(
          eq(ordersTable.id, orderId),
          ne(ordersTable.paymentStatus, 'refunded'),
        ),
      );
    if (state === 'completed')
      await db
        .update(ordersTable)
        .set({
          paymentStatus: 'refunded',
          ...(order.fulfillmentType === 'in_person'
            ? { status: 'refunded', fulfillmentState: 'handed_over' }
            : {}),
        })
        .where(eq(ordersTable.id, orderId));
    await db
      .insert(orderEventsTable)
      .values({
        orderId,
        type: `square_refund_${state}`,
        dedupeKey: `square-refund:${op.id}:${state}`,
        actor: actorId,
        source: 'square',
        externalEventId: refund.id,
        detail: `Full refund ${state}`,
      })
      .onConflictDoNothing();
    await tryReconcileSquareNotifications(db, env, orderId);
  } catch (error) {
    if (isSquareFailure(error) && !error.uncertain)
      await db
        .update(squareRefundOperations)
        .set({ state: 'failed', error: error.code })
        .where(
          and(
            eq(squareRefundOperations.id, op.id),
            eq(squareRefundOperations.state, 'unknown'),
          ),
        );
    await db
      .update(squareRefundOperations)
      .set({
        error:
          error instanceof HTTPException
            ? error.message
            : isSquareFailure(error)
              ? error.code
              : 'provider_outcome_unknown',
      })
      .where(
        and(
          eq(squareRefundOperations.id, op.id),
          ne(squareRefundOperations.state, 'completed'),
        ),
      );
    if (error instanceof HTTPException) throw error;
  }
  const [currentOperation] = await db
    .select()
    .from(squareRefundOperations)
    .where(eq(squareRefundOperations.id, op.id));
  if (['unknown', 'pending', 'failed'].includes(currentOperation.state))
    await db
      .update(ordersTable)
      .set({
        refundStatus: currentOperation.state,
        refundAmountCents: op.amountCents,
      })
      .where(
        and(
          eq(ordersTable.id, orderId),
          ne(ordersTable.paymentStatus, 'refunded'),
        ),
      );
  if (
    env.ORDER_NOTIFICATIONS_ENABLED === 'true' &&
    ['unknown', 'failed', 'cancel_unknown'].includes(currentOperation.state)
  ) {
    try {
      const alert = await enqueueAdminFailure(
        db,
        env,
        `refund:${op.id}:${currentOperation.state}`,
        'refund_failed',
        orderId,
      );
      if (alert) await deliverNotification(db, env, alert.id);
    } catch {
      console.error('refund.admin_alert_unavailable');
    }
  }
  return refundResponse(currentOperation);
}
