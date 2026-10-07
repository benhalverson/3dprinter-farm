import {clearCartLines} from './cartMutations';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { BASE_URL_V2 } from '../constants';
import { cart, orderEventsTable, ordersTable } from '../db/schema';
import type { WorkerEnv } from '../factory';
import { quoteSnapshotSchema } from './checkoutQuotes';
import {
  reservePendingOrderAssets,
  releasePaidOrderAssets,
} from './productAssets';

type Database = WorkerEnv['Variables']['db'];
type Environment = WorkerEnv['Bindings'];
/** Distinguishes definitive draft rejection from uncertain external outcomes. */
class SlantRejection extends Error {}
/** Reads a Slant response without treating a malformed or lost response as proof of failure. */
async function slantRequest(env: Environment, path: string, payload?: unknown) {
  const response = await fetch(`${BASE_URL_V2}orders${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${env.SLANT_API_V2}`,
      'Content-Type': 'application/json',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    if (
      response.status >= 400 &&
      response.status < 500 &&
      ![408, 429].includes(response.status)
    )
      throw new SlantRejection('Slant rejected request');
    throw new Error('Slant outcome requires reconciliation');
  }
  const parsed = z
    .object({
      publicOrderId: z.string().min(1).optional(),
      orderId: z.string().min(1).optional(),
      status: z.string().optional(),
      orderNumber: z.string().optional(),
      data: z
        .object({
          publicOrderId: z.string().min(1).optional(),
          orderId: z.string().min(1).optional(),
          id: z.string().min(1).optional(),
          status: z.string().optional(),
          orderNumber: z.string().optional(),
        })
        .optional(),
    })
    .parse(await response.json());
  return parsed;
}
/** Owns durable stage claims. An abandoned claim is ambiguous and never authorizes a second effect. */
export function createPaidOrderFulfillment(deps: {
  db: Database;
  env: Environment;
}) {
  const { db, env } = deps;
  return {
    /** Manufactures only a persisted verified online order; retains draft IDs before processing. */
    async fulfillPaidOrder(orderId: number): Promise<void> {
      const [order] = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .all();
      if (
        !order ||
        order.paymentStatus !== 'paid' ||
        order.fulfillmentType !== 'slant'
      )
        return;
      if (order.fulfillmentState === 'processed')
        return finalizePaidOrder(db, orderId);
      if (
        order.fulfillmentState !== 'ready' &&
        order.fulfillmentState !== 'drafted'
      )
        return;
      if (!env.SLANT_API_V2 || !env.SLANT_PLATFORM_ID) return;
      const stage =
        order.fulfillmentState === 'ready' ? 'drafting' : 'processing';
      const claimed = await db
        .update(ordersTable)
        .set({ fulfillmentState: stage })
        .where(
          and(
            eq(ordersTable.id, orderId),
            eq(ordersTable.fulfillmentState, order.fulfillmentState),
          ),
        )
        .returning({ id: ordersTable.id });
      if (!claimed.length) return;
      try {
        const lines = quoteSnapshotSchema.shape.lines.parse(
          JSON.parse(order.itemSnapshot || 'null'),
        );
        if (stage === 'drafting') {
          const customer = JSON.parse(order.customerSnapshot || 'null') as {
            email: string;
            shippingAddress: {
              name: string;
              line1: string;
              line2: string;
              city: string;
              state: string;
              zip: string;
              country: string;
            };
          };
          const address = customer.shippingAddress;
          const shippingAddress = {
            name: address.name,
            street1: address.line1,
            street2: address.line2,
            city: address.city,
            state: address.state,
            zipCode: address.zip,
            country: address.country,
            isResidential: true,
          };
          // Holds print references through uncertain provider outcomes; local immutable order remains authoritative.
          await reservePendingOrderAssets(
            db,
            JSON.parse(order.itemSnapshot || 'null'),
            `order-attempt:square-${orderId}`,
          );
          const draft = await slantRequest(env, '', {
            orderNumber: order.orderNumber,
            platformId: env.SLANT_PLATFORM_ID,
            customer: { email: customer.email, name: address.name },
            shippingAddress,
            billingAddress: shippingAddress,
            items: lines.map(line => ({
              name: line.name,
              sku: line.skuNumber,
              quantity: line.quantity,
              publicFileServiceId: line.publicFileServiceId,
              filamentId: line.filamentId,
              color: line.color,
              profile: line.filamentType,
            })),
            metadata: {
              checkoutAttemptId: order.checkoutAttemptId,
              squarePaymentId: order.squarePaymentId,
            },
          });
          const id =
            draft.publicOrderId ||
            draft.orderId ||
            draft.data?.publicOrderId ||
            draft.data?.orderId ||
            draft.data?.id;
          if (!id) throw new Error('Slant draft requires reconciliation');
          await db
            .update(ordersTable)
            .set({ slantPublicOrderId: id, fulfillmentState: 'drafted' })
            .where(
              and(
                eq(ordersTable.id, orderId),
                eq(ordersTable.fulfillmentState, 'drafting'),
              ),
            );
          return this.fulfillPaidOrder(orderId);
        }
        if (!order.slantPublicOrderId)
          throw new Error('Missing retained draft identity');
        const processed = await slantRequest(
          env,
          `/${encodeURIComponent(order.slantPublicOrderId)}`,
          {
            orderNumber: order.orderNumber,
            metadata: {
              checkoutAttemptId: order.checkoutAttemptId,
              squarePaymentId: order.squarePaymentId,
            },
          },
        );
        if (
          !['PROCESSING', 'SHIPPED', 'DELIVERED'].includes(
            (processed.status || processed.data?.status || '').toUpperCase(),
          )
        )
          throw new Error('Slant process confirmation requires reconciliation');
        const at = new Date().toISOString();
        await db
          .update(ordersTable)
          .set({
            fulfillmentState: 'processed',
            status: 'processing',
            slantStatus: 'PROCESSING',
            processedAt: at,
            updatedAt: at,
          })
          .where(
            and(
              eq(ordersTable.id, orderId),
              eq(ordersTable.fulfillmentState, 'processing'),
            ),
          );
        await finalizePaidOrder(db, orderId);
      } catch (error) {
        if (stage === 'drafting' && error instanceof SlantRejection)
          await releasePaidOrderAssets(db, orderId);
        await db
          .update(ordersTable)
          .set({
            fulfillmentState:
              stage === 'drafting'
                ? error instanceof SlantRejection
                  ? 'ready'
                  : 'draft_unknown'
                : 'process_unknown',
            status: 'paid_fulfillment_failed',
          })
          .where(
            and(
              eq(ordersTable.id, orderId),
              eq(ordersTable.fulfillmentState, stage),
            ),
          );
      }
    },
    /** Reconciles only retained process identities; never repeats ambiguous draft creation or manufacture. */
    async reconcilePaidOrder(orderId: number, recoveredDraftId?: string) {
      const [order] = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .all();
      if (
        !order ||
        order.paymentStatus !== 'paid' ||
        order.fulfillmentType !== 'slant'
      )
        return;
      if (order.fulfillmentState === 'processed')
        return finalizePaidOrder(db, orderId);
      const draftRecovery = ['drafting', 'draft_unknown'].includes(
        order.fulfillmentState || '',
      );
      const externalId =
        order.slantPublicOrderId ||
        (draftRecovery ? recoveredDraftId : undefined);
      if (!externalId) return;
      if (
        !draftRecovery &&
        !['processing', 'process_unknown'].includes(
          order.fulfillmentState || '',
        )
      )
        return;
      const response = await slantRequest(
        env,
        `/${encodeURIComponent(externalId)}`,
      );
      if (
        (response.orderNumber || response.data?.orderNumber) !==
        order.orderNumber
      )
        throw new Error('Slant association mismatch');
      const status = response.status || response.data?.status;
      if (draftRecovery && status?.toUpperCase() === 'DRAFT') {
        await db
          .update(ordersTable)
          .set({ slantPublicOrderId: externalId, fulfillmentState: 'drafted' })
          .where(
            and(
              eq(ordersTable.id, orderId),
              inArray(ordersTable.fulfillmentState, [
                'drafting',
                'draft_unknown',
              ]),
            ),
          );
        return;
      }
      if (
        !status ||
        !['PROCESSING', 'SHIPPED', 'DELIVERED'].includes(status.toUpperCase())
      )
        return;
      await db
        .update(ordersTable)
        .set({
          fulfillmentState: 'processed',
          slantPublicOrderId: externalId,
          slantStatus: status,
          status: status.toLowerCase(),
          processedAt: order.processedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(status.toUpperCase() === 'SHIPPED'
            ? { shippedAt: order.shippedAt || new Date().toISOString() }
            : {}),
          ...(status.toUpperCase() === 'DELIVERED'
            ? { deliveredAt: order.deliveredAt || new Date().toISOString() }
            : {}),
        })
        .where(
          and(
            eq(ordersTable.id, orderId),
            inArray(ordersTable.fulfillmentState, [
              'processing',
              'process_unknown',
              'draft_unknown',
              'drafting',
            ]),
          ),
        );
      await finalizePaidOrder(db, orderId);
    },
  };
}

/** Resumes snapshot-aware local cleanup after provider confirmation; external effects are never repeated. */
async function finalizePaidOrder(db: Database, orderId: number) {
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId))
    .all();
  if (!order || order.fulfillmentState !== 'processed') return;
  const lines = quoteSnapshotSchema.shape.lines.parse(
    JSON.parse(order.itemSnapshot || 'null'),
  );
  for (const line of lines)
    await clearCartLines(db,order.cartId||'',
        and(
          eq(cart.id, line.cartItemId),
          eq(cart.cartId, order.cartId || ''),
          eq(cart.userId, order.userId || ''),
          eq(cart.quantity, line.quantity),
          eq(cart.skuNumber, line.skuNumber),
          eq(cart.filamentId, line.filamentId),
          eq(cart.color, line.color),
          eq(cart.filamentType, line.filamentType),
        ),
      );
  await db
    .insert(orderEventsTable)
    .values({
      orderId,
      type: 'square_fulfillment_processed',
      dedupeKey: `square-fulfilled:${order.checkoutAttemptId}`,
      source: 'square',
      actor: 'square',
      externalEventId: order.squarePaymentId,
      previousStatus: 'paid',
      nextStatus: order.slantStatus || 'PROCESSING',
    })
    .onConflictDoNothing();
  await releasePaidOrderAssets(db, orderId);
}
