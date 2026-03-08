import type { z } from 'zod';
import type { orderSchema } from './db/schema';

/**
 * Runtime environment bindings for the Cloudflare Worker.
 *
 * These must stay aligned with `wrangler.toml` and the generated
 * `worker-configuration.d.ts` (`interface Env`).  The canonical source of
 * truth for infrastructure bindings (KV, R2, D1) is `wrangler.toml`; secrets
 * are provisioned via `wrangler secret put` and are listed in the
 * `ProductionEnv` block of `worker-configuration.d.ts`.
 *
 * Binding purposes:
 *  - BUCKET            – R2 bucket for STL/upload files
 *  - PHOTO_BUCKET      – R2 bucket for product photos
 *  - DB                – D1 (SQLite) primary database
 *  - DB_PREVIEW        – D1 preview/staging database
 *  - COLOR_CACHE       – KV namespace used to cache filament colour responses
 *  - RATE_LIMIT_KV     – KV namespace used by the rate-limiting middleware
 *  - SLANT_API         – Slant3D v1 API key
 *  - SLANT_API_V2      – Slant3D v2 API bearer token
 *  - SLANT_PLATFORM_ID – Slant3D platform identifier
 *  - STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET – Stripe credentials
 *  - DOMAIN            – Public base URL (e.g. https://rc-store.benhalverson.dev)
 *  - JWT_SECRET        – Secret for JWT signing
 *  - BETTER_AUTH_SECRET – Secret for Better Auth sessions (≥ 32 chars)
 *  - RP_ID / RP_NAME   – WebAuthn Relying Party identity
 *  - PASSKEY_ORIGIN    – Allowed passkey origin (optional; defaults to DOMAIN)
 *  - MAILJET_*         – Mailjet transactional email credentials
 *  - ENCRYPTION_PASSPHRASE – Passphrase for profile field encryption
 *  - R2_PUBLIC_BASE_URL / R2_PHOTO_BASE_URL – CDN base URLs for R2 assets
 */
export type Bindings = {
  /** R2 bucket for STL/upload files (wrangler binding: BUCKET) */
  BUCKET: R2Bucket;
  /** R2 bucket for product photos (wrangler binding: PHOTO_BUCKET) */
  PHOTO_BUCKET: R2Bucket;
  SLANT_API: string;
  SLANT_API_V2: string;
  SLANT_PLATFORM_ID: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  DOMAIN: string;
  /** Primary D1 SQLite database */
  DB: D1Database;
  /** Preview/staging D1 SQLite database */
  DB_PREVIEW?: D1Database;
  /**
   * KV namespace used to cache filament colour API responses.
   * Configured as a KV namespace in wrangler.toml (binding: COLOR_CACHE).
   */
  COLOR_CACHE: KVNamespace;
  JWT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  RP_ID: string;
  RP_NAME: string;
  PASSKEY_ORIGIN?: string;
  /** KV namespace used by the rate-limiting middleware (binding: RATE_LIMIT_KV) */
  RATE_LIMIT_KV: KVNamespace;
  MAILJET_API_KEY: string;
  MAILJET_API_SECRET: string;
  MAILJET_CONTACT_LIST_ID: string;
  MAILJET_TEMPLATE_ID: string;
  MAILJET_SENDER_EMAIL: string;
  MAILJET_SENDER_NAME: string;
  ENCRYPTION_PASSPHRASE: string;
  R2_PUBLIC_BASE_URL: string;
  R2_PHOTO_BASE_URL: string;
};

export interface SliceResponse {
  message: string;
  data: {
    price: number;
  };
}

export interface ErrorResponse {
  error: string;
  details: Details;
}

export interface Details {
  error: Error;
  url: string;
}

export interface Error {
  message: string;
  status: number;
}

export interface FilamentColorsResponse {
  filaments: Filament[];
}

export interface Filament {
  filament: FilamentType;
  hexColor: string;
  colorTag: string;
  profile: string;
}

// V2 API Filament Types
export interface FilamentV2 {
  publicId: string;
  name: string;
  provider: string;
  profile: 'PLA' | 'PETG' | 'ABS';
  color: string;
  hexValue: string;
  public: boolean;
  available: boolean;
}

export interface FilamentV2Response {
  success: boolean;
  message: string;
  data: FilamentV2[];
  count: number;
  lastUpdated?: string;
}

// Slant3D V2 File API Types
export interface STLMetrics {
  dimensionX: number;
  dimensionY: number;
  dimensionZ: number;
  weight: number;
  volume: number;
  surfaceArea: number;
  imageURL: string;
}

export interface Slant3DFile {
  publicFileServiceId: string;
  name: string;
  ownerId?: string;
  platformId: string;
  type: 'stl';
  fileURL: string;
  STLMetrics?: STLMetrics;
  createdAt: string;
  updatedAt: string;
}

export interface Slant3DFileResponse {
  success: boolean;
  message: string;
  data: Slant3DFile;
}

// export interface Details {
// 	error: string;
// }

enum FilamentType {
  PLA = 'PLA',
  PETG = 'PETG',
}

export interface ListResponse {
  stl: string;
  key?: string;
  size: number;
  version: string;
}

export type OrderData = z.infer<typeof orderSchema>;

export type OrderResponse = {
  totalPrice: number;
  shippingCost: number;
  printingCost: number;
};

// Payment-related types
export interface PayPalOrderResponse {
  id: string;
  status: string;
  links?: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
  error?: string;
}

export interface CartItemWithProduct {
  id: number;
  skuNumber: string | null;
  quantity: number;
  color: string | null;
  filamentType: string | null;
  productName: string | null;
  stl: string | null;
}

export interface Slant3DOrderData {
  email: string;
  phone: string;
  name: string;
  orderNumber: string;
  filename: string | undefined;
  fileURL: string | null;
  bill_to_street_1: string;
  bill_to_street_2: string;
  bill_to_street_3: string;
  bill_to_city: string;
  bill_to_state: string;
  bill_to_zip: string;
  bill_to_country_as_iso: string;
  bill_to_is_US_residential: string;
  ship_to_name: string;
  ship_to_street_1: string;
  ship_to_street_2: string;
  ship_to_street_3: string;
  ship_to_city: string;
  ship_to_state: string;
  ship_to_zip: string;
  ship_to_country_as_iso: string;
  ship_to_is_US_residential: string;
  order_item_name: string | null;
  order_quantity: string;
  order_image_url: string;
  order_sku: string | null;
  order_item_color: string;
  profile: string | null;
}

export interface Slant3DOrderResponse {
  orderId?: string;
}

// Test response types
export interface PaymentStatusResponse {
  status: string;
}

export interface StripeWebhookResponse {
  success?: boolean;
  orderId?: string;
  error?: string;
  received?: boolean;
}
