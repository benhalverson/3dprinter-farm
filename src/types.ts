import { z } from 'zod';
import { orderSchema } from './db/schema';

export type Bindings = {
	BUCKET: R2Bucket;
	PHOTOS_BUCKET: R2Bucket;
	SLANT_API: string;
	STRIPE_PUBLISHABLE_KEY: string;
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
	DOMAIN: string;
	DB: D1Database;
	COLOR_CACHE: Cache;
	JWT_SECRET: string;
	RP_ID: string;
	RP_NAME: string;
	RATE_LIMIT_KV: KVNamespace;
	MAILJET_API_KEY: string;
	MAILJET_API_SECRET: string;
	MAILJET_CONTACT_LIST_ID: string;
	MAILJET_TEMPLATE_ID: string;
	MAILJET_SENDER_EMAIL: string;
	MAILJET_SENDER_NAME: string;
	ENCRYPTION_PASSPHRASE: string;
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
