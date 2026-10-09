import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { cart, orderReconciliationAttemptsTable, ordersTable } from '../db/schema';
import type { WorkerEnv } from '../factory';
import { tryReconcileSquareNotifications } from '../lib/notifications';
import { quoteSnapshotSchema } from './checkoutQuotes';
import { createPaidOrderFulfillment } from './paidOrderFulfillment';

type Order = typeof ordersTable.$inferSelect;
type Database = WorkerEnv['Variables']['db'];

/**
 * Turn an authorized admin reconciliation request into a persisted attempt and
 * diagnostics for the response. The route handles access and refund holds; this
 * coordinator reserves the audit before calling fulfillment recovery, compares
 * the resulting local evidence, and retries eligible notifications.
 *
 * Keeping the audit here leaves provider state transitions in paidOrderFulfillment.
 * In-person orders record a no-op; Slant recovery never submits manufacture.
 * A lost invocation can leave its attempt running, rather than claim completion.
 */
export async function reconcileSquareOrder(
  db: Database,
  env: WorkerEnv['Bindings'],
  order: Order,
  recoveredDraftId?: string,
) {
  const detectedIssues: string[] = [];
  const actionsTaken: string[] = [];
  const at = new Date().toISOString();
  const [attempt] = await db.insert(orderReconciliationAttemptsTable).values({
    orderId: order.id,
    triggerSource: 'admin',
    startingState: JSON.stringify({
      orderId: order.id, squarePaymentId: order.squarePaymentId,
      squareOrderId: order.squareOrderId, slantPublicOrderId: order.slantPublicOrderId,
      paymentStatus: order.paymentStatus, fulfillmentState: order.fulfillmentState,
      status: order.status, slantStatus: order.slantStatus,
    }),
    resultStatus: 'running', createdAt: at, updatedAt: at,
  }).returning({ id: orderReconciliationAttemptsTable.id });
  if (!attempt) throw new Error('Reconciliation attempt was not saved');

  /**
   * Persist this invocation's diagnostics before logging its outcome. The captured
   * attempt ID keeps concurrent admin requests' audit records separate; a failed
   * write propagates instead of reporting a completed audit.
   */
  const finish = async (resultStatus: string, errorMessage: string | null = null) => {
    await db.update(orderReconciliationAttemptsTable).set({
      resultStatus, errorMessage,
      detectedIssueType: detectedIssues.length ? JSON.stringify(detectedIssues) : null,
      actionsTaken: actionsTaken.length ? JSON.stringify(actionsTaken) : null,
      updatedAt: new Date().toISOString(),
    }).where(eq(orderReconciliationAttemptsTable.id, attempt.id));
    console.info(JSON.stringify({
      event: 'order.reconciliation', orderId: order.id, attemptId: attempt.id,
      squarePaymentId: order.squarePaymentId, slantPublicOrderId: order.slantPublicOrderId,
      detectedIssues, actionsTaken, resultStatus,
    }));
  };

  let current = order;
  try {
    if (order.fulfillmentType === 'slant') {
      let rawLines: unknown;
      try { rawLines = JSON.parse(order.itemSnapshot || 'null'); } catch { rawLines = null; }
      const lines = quoteSnapshotSchema.shape.lines.safeParse(rawLines);
      if (!lines.success) detectedIssues.push('missing_or_invalid_item_snapshot');
      if (!order.customerSnapshot) detectedIssues.push('missing_customer_snapshot');
      if (order.paymentStatus === 'paid' && !order.slantPublicOrderId)
        detectedIssues.push('missing_slant_order_id');
      if (order.paymentStatus === 'paid' && !['processed', 'canceled'].includes(order.fulfillmentState || ''))
        detectedIssues.push('paid_without_fulfillment');
      if (['drafting', 'draft_unknown', 'processing', 'process_unknown'].includes(order.fulfillmentState || ''))
        detectedIssues.push('fulfillment_outcome_unknown');

      /**
       * Read cart rows still matching this owner's immutable paid snapshot before
       * and after fulfillment finalization. These observations describe cleanup;
       * they neither delete rows nor classify later additions as paid leftovers.
       */
      const matchingCartRows = async () => {
        if (!order.cartId || !lines.success) return [];
        const rows = await db.select().from(cart).where(eq(cart.cartId, order.cartId));
        return rows.filter(row => row.userId === order.userId && lines.data.some(line =>
          row.id === line.cartItemId && row.quantity === line.quantity &&
          row.skuNumber === line.skuNumber && row.filamentId === line.filamentId &&
          row.color === line.color && row.filamentType === line.filamentType));
      };
      const beforeCart = order.fulfillmentState === 'processed' ? await matchingCartRows() : [];
      if (beforeCart.length) detectedIssues.push('cart_not_cleared_after_fulfillment');
      // Finalization needs the immutable snapshot; malformed evidence requires operator repair.
      if (lines.success && order.customerSnapshot) {
        await createPaidOrderFulfillment({ db, env }).reconcilePaidOrder(order.id, recoveredDraftId, true);
        const [refreshed] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id));
        if (!refreshed) throw new Error('Order unavailable after reconciliation');
        current = refreshed;
        if (current.slantStatus !== order.slantStatus || current.status !== order.status) {
          detectedIssues.push('local_status_stale');
          actionsTaken.push('updated_local_status');
        }
        if (current.fulfillmentState !== order.fulfillmentState)
          actionsTaken.push('updated_fulfillment_state');
        if (beforeCart.length) {
          const remaining = await matchingCartRows();
          if (beforeCart.some(row => !remaining.some(item => item.id === row.id)))
            actionsTaken.push('cleared_paid_cart_lines');
        }
        await tryReconcileSquareNotifications(db, env, order.id);
      }
    }
  } catch {
    detectedIssues.push('reconciliation_unavailable');
    await finish('failed', 'Order recovery unavailable; reconcile again before any retry');
    throw new HTTPException(502, { res: Response.json({
      error: 'Order reconciliation unavailable; retry reconciliation before resubmitting fulfillment',
    }, { status: 502 }) });
  }
  const reconciliationStatus = actionsTaken.length ? 'recovered' : detectedIssues.length ? 'reported' : 'no_action';
  await finish(reconciliationStatus);
  return {
    success: true, orderId: order.id, attemptId: attempt.id,
    resultStatus: current.fulfillmentState, reconciliationStatus,
    localStatus: current.status, slantStatus: current.slantStatus,
    detectedIssues, actionsTaken,
    recommendedAction: reconciliationStatus === 'reported'
      ? 'Review persisted evidence and recover missing snapshots or Slant identity; do not resubmit ambiguous fulfillment'
      : null,
    order: current,
  };
}
