import type { DrizzleD1Database } from 'drizzle-orm/d1';

import { BASE_URL_V2 } from '../constants';
import type * as schema from '../db/schema';
import { orderEventsTable, ordersTable } from '../db/schema';
import type { Bindings } from '../types';
import { generateOrderNumber } from '../utils/generateOrderNumber';

type Database = DrizzleD1Database<typeof schema>;

const DEFAULT_SLANT_FILAMENT_ID = '76fe1f79-3f1e-43e4-b8f4-61159de5b93c';
const ALLOWED_COLORS = new Set([
  'black',
  'white',
  'gray',
  'grey',
  'yellow',
  'red',
  'gold',
  'purple',
  'blue',
  'orange',
  'green',
  'pink',
  'matteBlack',
  'lunarRegolith',
  'petgBlack',
]);

export type PaidOrderItem = {
  id: number;
  skuNumber: string | null;
  quantity: number;
  color: string | null;
  filamentType: string | null;
  filamentId: string | null;
  productName: string | null;
  productImage: string | null;
  productPrice: number | null;
  stl: string | null;
  publicFileServiceId: string | null;
};

export type PaidOrderProfile = {
  email: string;
  firstName: string;
  lastName: string;
  shippingAddress: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
};

export type PaidOrderInput = {
  cartId: string;
  userId: string;
  stripeEventId: string;
  stripeObjectId: string;
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  idempotencyKey: string;
  customerEmail?: string;
};

export type PaidOrderFulfillmentResult = {
  localOrderId: number;
  publicOrderId: string;
  orderNumber: string;
};

export class PaidOrderFulfillmentError extends Error {
  constructor(
    public readonly stage: 'draft' | 'process',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PaidOrderFulfillmentError';
  }
}

export interface PaidOrderFulfillment {
  fulfillPaidOrder(input: {
    fulfillment: PaidOrderInput;
    profile: PaidOrderProfile;
    items: PaidOrderItem[];
  }): Promise<PaidOrderFulfillmentResult>;
}

function normalizePhone(value: string) {
  const digits = (value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits : '0000000000';
}

function normalizeColor(raw: string | null | undefined) {
  if (!raw) return 'black';
  const trimmed = raw.trim();
  if (ALLOWED_COLORS.has(trimmed)) return trimmed;
  for (const color of ALLOWED_COLORS) {
    if (color.toLowerCase() === trimmed.toLowerCase()) return color;
  }
  return 'black';
}

function extractSlantOrderId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const response = payload as {
    publicOrderId?: string;
    orderId?: string;
    data?: { publicOrderId?: string; orderId?: string; id?: string };
  };
  return (
    response.publicOrderId ||
    response.orderId ||
    response.data?.publicOrderId ||
    response.data?.orderId ||
    response.data?.id
  );
}

function itemSnapshot(items: PaidOrderItem[]) {
  return items.map(item => ({
    skuNumber: item.skuNumber,
    name: item.productName,
    quantity: item.quantity,
    color: item.color,
    filamentType: item.filamentType,
    filamentId: item.filamentId || DEFAULT_SLANT_FILAMENT_ID,
    publicFileServiceId: item.publicFileServiceId,
    image: item.productImage,
    price: item.productPrice,
  }));
}

function totalCents(items: PaidOrderItem[]) {
  return items.reduce(
    (sum, item) =>
      sum + Math.round((item.productPrice || 0) * 100) * item.quantity,
    0,
  );
}

export function createPaidOrderFulfillment(deps: {
  db: Database;
  env: Pick<Bindings, 'SLANT_API_V2' | 'SLANT_PLATFORM_ID'>;
  clock?: () => string;
  orderNumber?: () => string;
}): PaidOrderFulfillment {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const nextOrderNumber = deps.orderNumber ?? generateOrderNumber;

  return {
    async fulfillPaidOrder({ fulfillment, profile, items }) {
      const orderNumber = nextOrderNumber();
      const fullName =
        `${profile.firstName} ${profile.lastName}`.trim() || profile.email;
      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deps.env.SLANT_API_V2}`,
      };
      const payload = {
        orderNumber,
        platformId: deps.env.SLANT_PLATFORM_ID,
        customer: {
          email:
            profile.email || fulfillment.customerEmail || 'guest@example.com',
          phone: normalizePhone(profile.phone),
          name: fullName,
        },
        billingAddress: {
          street1: profile.shippingAddress,
          street2: '',
          city: profile.city,
          state: profile.state,
          zipCode: profile.zipCode,
          country: 'US',
          isResidential: true,
        },
        shippingAddress: {
          name: fullName,
          street1: profile.shippingAddress,
          street2: '',
          city: profile.city,
          state: profile.state,
          zipCode: profile.zipCode,
          country: 'US',
          isResidential: true,
        },
        items: items.map(item => {
          if (!item.publicFileServiceId)
            throw new Error('Missing publicFileServiceId');
          return {
            name: item.productName,
            sku: item.skuNumber,
            quantity: item.quantity,
            publicFileServiceId: item.publicFileServiceId,
            filamentId: item.filamentId || DEFAULT_SLANT_FILAMENT_ID,
            color: normalizeColor(item.color),
            profile: item.filamentType,
          };
        }),
        metadata: {
          cartId: fulfillment.cartId,
          stripeEventId: fulfillment.stripeEventId,
          stripeObjectId: fulfillment.stripeObjectId,
          idempotencyKey: fulfillment.idempotencyKey,
        },
      };

      let draftResponse: Response;
      try {
        draftResponse = await fetch(`${BASE_URL_V2}orders`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(payload),
        });
      } catch (error) {
        throw new PaidOrderFulfillmentError(
          'draft',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!draftResponse.ok)
        throw new PaidOrderFulfillmentError(
          'draft',
          `Slant3D order draft failed with ${draftResponse.status}`,
          draftResponse.status,
        );
      const publicOrderId = extractSlantOrderId(await draftResponse.json());
      if (!publicOrderId)
        throw new PaidOrderFulfillmentError(
          'draft',
          'Slant3D draft response missing public order id',
        );

      let processResponse: Response;
      try {
        processResponse = await fetch(`${BASE_URL_V2}orders/${publicOrderId}`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            orderNumber,
            metadata: {
              stripeEventId: fulfillment.stripeEventId,
              stripeObjectId: fulfillment.stripeObjectId,
              idempotencyKey: fulfillment.idempotencyKey,
            },
          }),
        });
      } catch (error) {
        throw new PaidOrderFulfillmentError(
          'process',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!processResponse.ok)
        throw new PaidOrderFulfillmentError(
          'process',
          `Slant3D order process failed with ${processResponse.status}`,
          processResponse.status,
        );

      const at = clock();
      const customerSnapshot = {
        email: profile.email || fulfillment.customerEmail || null,
        firstName: profile.firstName,
        lastName: profile.lastName,
        name: fullName || profile.email || fulfillment.customerEmail || null,
        phone: normalizePhone(profile.phone),
        shippingAddress: {
          street1: profile.shippingAddress,
          street2: '',
          city: profile.city,
          state: profile.state,
          zipCode: profile.zipCode,
          country: 'US',
          isResidential: true,
        },
      };
      const firstItem = items[0];
      const [order] = await deps.db
        .insert(ordersTable)
        .values({
          userId: fulfillment.userId,
          orderNumber,
          cartId: fulfillment.cartId,
          filename:
            firstItem?.productName || firstItem?.skuNumber || orderNumber,
          fileURL:
            firstItem?.stl ||
            firstItem?.publicFileServiceId ||
            `slant3d:${publicOrderId}`,
          shipToName: fullName,
          shipToStreet1: profile.shippingAddress,
          shipToStreet2: '',
          shipToCity: profile.city,
          shipToState: profile.state,
          shipToZip: profile.zipCode,
          shipToCountryISO: 'US',
          billToStreet1: profile.shippingAddress,
          billToStreet2: '',
          billToCity: profile.city,
          billToState: profile.state,
          billToZip: profile.zipCode,
          billToCountryISO: 'US',
          status: 'processing',
          slantStatus: 'PROCESSING',
          slantPublicOrderId: publicOrderId,
          stripeCheckoutSessionId: fulfillment.stripeCheckoutSessionId ?? null,
          stripePaymentIntentId: fulfillment.stripePaymentIntentId ?? null,
          stripeEventId: fulfillment.stripeEventId,
          customerEmail: profile.email || fulfillment.customerEmail || null,
          totalAmountCents: totalCents(items),
          currency: 'usd',
          itemSnapshot: JSON.stringify(itemSnapshot(items)),
          customerSnapshot: JSON.stringify(customerSnapshot),
          createdAt: at,
          updatedAt: at,
          processedAt: at,
        })
        .returning({ id: ordersTable.id });
      if (!order?.id) throw new Error('Failed to persist processed order');
      await deps.db.insert(orderEventsTable).values({
        orderId: order.id,
        type: 'stripe_fulfillment_processed',
        detail: `Stripe payment processed into Slant3D order ${publicOrderId}`,
        actor: 'stripe',
        externalEventId: fulfillment.stripeEventId,
        source: 'stripe',
        previousStatus: 'paid',
        nextStatus: 'PROCESSING',
        metadata: JSON.stringify({
          ...fulfillment,
          slantPublicOrderId: publicOrderId,
        }),
        createdAt: at,
      });
      return { localOrderId: order.id, publicOrderId, orderNumber };
    },
  };
}
