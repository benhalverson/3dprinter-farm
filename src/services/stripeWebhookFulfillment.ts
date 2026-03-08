import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { BASE_URL } from '../constants';
import { cart, productsTable } from '../db/schema';
import * as schema from '../db/schema';
import type {
  CartItemWithProduct,
  Slant3DOrderData,
  Slant3DOrderResponse,
} from '../types';
import { generateOrderNumber } from '../utils/generateOrderNumber';

type AppDatabase = DrizzleD1Database<typeof schema>;

export const ALLOWED_FILAMENT_COLORS = new Set([
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

export function normalizeColor(raw: string | null | undefined): string {
  if (!raw) return 'black';
  const trimmed = raw.trim();
  if (ALLOWED_FILAMENT_COLORS.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const color of ALLOWED_FILAMENT_COLORS) {
    if (color.toLowerCase() === lower) return color;
  }
  return 'black';
}

export function normalizePhone(value: string): string {
  const digits = (value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits : '0000000000';
}

export interface UserProfile {
  email: string;
  firstName: string;
  lastName: string;
  shippingAddress: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
}

export function buildOrderData(
  cartItems: CartItemWithProduct[],
  profile: UserProfile,
): Slant3DOrderData[] {
  return cartItems.map((item): Slant3DOrderData => {
    const stlPath = item.stl;
    const filenameCandidate = stlPath?.split('/').pop();
    const normalizedColor = normalizeColor(item.color);
    const fullName =
      `${profile.firstName} ${profile.lastName}`.trim() || profile.email;

    return {
      email: profile.email,
      phone: profile.phone,
      name: fullName,
      orderNumber: generateOrderNumber(),
      filename: filenameCandidate,
      fileURL: stlPath,
      bill_to_street_1: profile.shippingAddress,
      bill_to_street_2: '',
      bill_to_street_3: '',
      bill_to_city: profile.city,
      bill_to_state: profile.state,
      bill_to_zip: profile.zipCode,
      bill_to_country_as_iso: 'US',
      bill_to_is_US_residential: 'true',
      ship_to_name: fullName,
      ship_to_street_1: profile.shippingAddress,
      ship_to_street_2: '',
      ship_to_street_3: '',
      ship_to_city: profile.city,
      ship_to_state: profile.state,
      ship_to_zip: profile.zipCode,
      ship_to_country_as_iso: 'US',
      ship_to_is_US_residential: 'true',
      order_item_name: item.productName,
      order_quantity: String(item.quantity),
      order_image_url: '',
      order_sku: item.skuNumber,
      order_item_color: normalizedColor,
      profile: item.filamentType,
    };
  });
}

export async function fetchCartItems(
  db: AppDatabase,
  cartId: string,
): Promise<CartItemWithProduct[]> {
  return db
    .select({
      id: cart.id,
      skuNumber: cart.skuNumber,
      quantity: cart.quantity,
      color: cart.color,
      filamentType: cart.filamentType,
      productName: productsTable.name,
      stl: productsTable.stl,
    })
    .from(cart)
    .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
    .where(eq(cart.cartId, cartId));
}

/**
 * Thrown when the Slant3D API returns a non-2xx response.
 * Callers can catch this specifically to return a 502 Bad Gateway.
 */
export class Slant3DApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Slant3DApiError';
  }
}

export async function submitOrderToSlant3D(
  orderData: Slant3DOrderData[],
  slantApiKey: string,
): Promise<{ orderId: string }> {
  const response = await fetch(`${BASE_URL}order/estimate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': slantApiKey,
    },
    body: JSON.stringify(orderData),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      'Slant3D order creation failed:',
      response.status,
      errorText,
    );
    console.error('Failed order data:', JSON.stringify(orderData, null, 2));
    throw new Slant3DApiError('Order creation failed');
  }

  const orderResponse = (await response.json()) as Slant3DOrderResponse;
  console.log('Slant3D order created successfully:', orderResponse);
  return { orderId: orderResponse.orderId || 'created' };
}

export async function clearCart(
  db: AppDatabase,
  cartId: string,
): Promise<void> {
  await db.delete(cart).where(eq(cart.cartId, cartId));
  console.log('Cart cleared for cartId:', cartId);
}
