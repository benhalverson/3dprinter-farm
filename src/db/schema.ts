import {
	integer,
	sqliteTable,
	text,
	real,
	primaryKey,
	uniqueIndex,
	blob,
} from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

export const cart = sqliteTable('cart', {
	id: integer('id').primaryKey(),
	cartId: integer('cart_id').notNull(),
	skuNumber: text('sku_number').notNull(),
	quantity: integer('quantity').default(1).notNull(),
	color: text('color').default('#000000'),
	filamentType: text('filament_type').notNull(),
});

export const leads = sqliteTable('leads', {
	id: integer('id').primaryKey(),
	email: text('email').unique(),
	name: text('name').notNull(),
	status: text('status'),
	confirmedAt: integer('confirmed_at'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at'),
});

export const usPhoneNumberSchema = z
	.string()
	.regex(
		/^\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})$/,
		'Invalid US phone number format'
	);

export const productsTable = sqliteTable('products', {
   id: integer('id').primaryKey({ autoIncrement: true }),
   name: text('name').notNull(),
   description: text('description').notNull(),
   image: text('image').default(''),
   stl: text('stl').notNull(),
   price: real('price').default(0).notNull(),
   filamentType: text('filament_type').notNull().default('PLA'),
   skuNumber: text('sku_number').default(''),
   color: text('color').default('#000000'),
   stripeProductId: text('stripe_product_id'),
   stripePriceId: text('stripe_price_id'),
});

export const ProductsDataSchema = z
	.object({
		id: z.number().optional(),
		name: z.string(),
		description: z.string(),
		image: z.string(),
		stl: z.string(),
		price: z.number(),
		filamentType: z.string(),
		color: z.string(),
		skuNumber: z.string(),
	})
	.omit({ id: true, skuNumber: true });

export const users = sqliteTable('users', {
	id: integer('id').primaryKey(),
	email: text('email').notNull(),
	passwordHash: text('password_hash').notNull(),
	salt: text('salt').notNull(),
	firstName: text('first_name').default('').notNull(),
	lastName: text('last_name').default('').notNull(),
	shippingAddress: text('shipping_address').default('').notNull(),
	billingAddress: text('billing_address').default('').notNull(),
	city: text('city').notNull().default(''),
	state: text('state').notNull().default(''),
	zipCode: text('zip_code').notNull().default(''),
	country: text('country').notNull().default(''),
	phone: text('phone').notNull().default(''),
	role: text('role').default('user').notNull(),
});

const OrderDataSchema = z.object({
	id: z.number(),
	userId: z.number(),
	orderNumber: z.string(),
	filename: z.string().trim(),
	fileURL: z.string(),

	billToStreet1: z.string(),
	billToStreet2: z.string().optional(),
	billToStreet3: z.string().optional(),
	billToCity: z.string(),
	billToState: z.string(),
	billToZip: z.string(),
	billToCountryISO: z.string(),
	billToIsUSResidential: z.number().optional(),

	shipToName: z.string(),
	shipToStreet1: z.string(),
	shipToStreet2: z.string().optional(),
	shipToStreet3: z.string().optional(),
	shipToCity: z.string(),
	shipToState: z.string().optional(),
	shipToZip: z.string().optional(),
	shipToCountryISO: z.string(),
	shipToIsUSResidential: z.number().optional(),
});

export type OrderData = z.infer<typeof OrderDataSchema>;
export type ProductData = z.infer<typeof ProductsDataSchema>;
export type ProfileData = z.infer<typeof ProfileDataSchema>;

export const ordersTable = sqliteTable('ordersTable', {
	id: integer('id').primaryKey(),
	userId: integer('user_id')
		.references(() => users.id, { onDelete: 'cascade' }) // Establish relationship with users table
		.notNull(),
	orderNumber: text('order_number').notNull().unique(),
	filename: text('filename'),
	fileURL: text('file_url').notNull(),

	// Shipping address fields specific to each order
	shipToName: text('ship_to_name').notNull(),
	shipToStreet1: text('ship_to_street_1').notNull(),
	shipToStreet2: text('ship_to_street_2'),
	shipToCity: text('ship_to_city').notNull(),
	shipToState: text('ship_to_state').notNull(),
	shipToZip: text('ship_to_zip').notNull(),
	shipToCountryISO: text('ship_to_country_iso').notNull(),

	// Billing address fields (if needed)
	billToStreet1: text('bill_to_street_1'),
	billToStreet2: text('bill_to_street_2'),
	billToCity: text('bill_to_city'),
	billToState: text('bill_to_state'),
	billToZip: text('bill_to_zip'),
	billToCountryISO: text('bill_to_country_iso'),
});

export const authenticators = sqliteTable(
	'authenticators',
	{
		id: integer().primaryKey().notNull(),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		credentialId: text('credential_id').notNull(),
		credentialPublicKey: blob('credential_public_key', {
			mode: 'buffer',
		}).notNull(),
		counter: integer('counter').notNull().default(0),
	},
	(table) => {
		return {
			userCredUnique: uniqueIndex('authenticators_user_credential_unique').on(
				table.userId,
				table.credentialId
			),
		};
	}
);

export const webauthnChallenges = sqliteTable(
	'webauthn_challenges',
	{
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		challenge: text('challenge').notNull(),
	},
	(table) => {
		return {
			pk: primaryKey(table.userId),
		};
	}
);
export const leadsSchema = z.object({
	email: z.string(),
	name: z.string(),
});

export const signUpSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
});

export const signInSchema = z.object({
	email: z.string().email(),
	password: z.string(),
});

export const idSchema = z.object({
	id: z.number().int(),
});

export const orderSchema = z
	.object({
		email: z
			.string()
			.email({
				message: 'Invalid email format',
			})
			.email()
			.min(5)
			.trim(),
		phone: z
			.string({
				required_error: 'Phone number is required',
				invalid_type_error: 'Phone number should be a string',
			})
			.trim()
			.toLowerCase(),
		name: z
			.string({
				required_error: 'Name is required',
			})
			.trim(),
		orderNumber: z
			.string({
				required_error: 'Order number is required',
			})
			.trim(),
		filename: z.string().trim(),
		fileURL: z.string().trim().url(),
		bill_to_street_1: z.string().trim(),
		bill_to_street_2: z.string().trim().optional(),
		bill_to_street_3: z.string().trim().optional(),
		bill_to_city: z.string().trim(),
		bill_to_state: z.string().trim(),
		bill_to_zip: z.string().trim(),
		bill_to_country_as_iso: z.string(),
		bill_to_is_US_residential: z.string(),
		ship_to_name: z.string(),
		ship_to_street_1: z.string(),
		ship_to_street_2: z.string().optional(),
		ship_to_street_3: z.string().optional(),
		ship_to_city: z.string(),
		ship_to_state: z.string(),
		ship_to_zip: z.string(),
		ship_to_country_as_iso: z.string(),
		ship_to_is_US_residential: z.string(),
		order_item_name: z.string(),
		order_quantity: z.string(),
		order_image_url: z.string().url().optional(),
		order_sku: z.string(),
		order_item_color: z.string().optional(),
	})
	.strict();

export const addProductSchema = z.object({
	name: z.string(),
	description: z.string(),
	stl: z.string(),
	price: z.number(),
	filamentType: z.string(),
	color: z.string(),
	image: z.string(),
});

export const updateProductSchema = z.object({
	id: z.number(),
	name: z.string(),
	description: z.string(),
	price: z.number(),
	filamentType: z.string(),
	color: z.string(),
	image: z.string(),
});

export const ProfileDataSchema = z.object({
	id: z.number().optional(),
	firstName: z.string().min(1, 'First name is required'),
	lastName: z.string().min(1, 'Last name is required'),
	shippingAddress: z.string().trim().min(10, 'Shipping address is required'),
	city: z.string().trim().min(1, 'City is required'),
	state: z.string().trim().min(1, 'State is required').max(2),
	zipCode: z.string().trim().min(1, 'Zip code is required').max(5),
	country: z.string().trim().min(1, 'Country is required'),
	phone: usPhoneNumberSchema,
});

export const addCartItemSchema = z.object({
	cartId: z.string().uuid(),
	skuNumber: z.number().int(),
	quantity: z.number().int().min(1).max(69),
	color: z.string(),
	filamentType: z.string(),
})
