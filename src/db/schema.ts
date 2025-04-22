import { integer, sqliteTable, text, real, primaryKey, uniqueIndex, blob } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

export const productsTable = sqliteTable('products', {
  id: integer('id').primaryKey({autoIncrement: true}),
  name: text('name').notNull(),
  description: text('description').notNull(),
  image: text('image').default(''),
  stl: text('stl').notNull(),
  price: real('price').default(0).notNull(),
  filamentType: text('filament_type').notNull().default('PLA'),
	skuNumber: text('sku_number').default(''),
  color: text('color').default('#000000'),
});

export const ProductsDataSchema = z.object({
	id: z.number().optional(),
	name: z.string(),
	description: z.string(),
	image: z.string(),
	stl: z.string(),
	price: z.number(),
	filamentType: z.string(),
	color: z.string(),
	skuNumber: z.string(),
}).omit({ id: true, skuNumber: true });

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
	salt: text('salt').notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  shippingAddress: text('shipping_address').notNull(),
  billingAddress: text('billing_address').notNull(),
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

export const ordersTable = sqliteTable('orders', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  orderNumber: text('order_number').notNull().unique(),
  filename: text('filename'),
  fileURL: text('file_url').notNull(),

  billToStreet1: text('bill_to_street_1').notNull(),
  billToStreet2: text('bill_to_street_2'),
  billToStreet3: text('bill_to_street_3'),
  billToCity: text('bill_to_city').notNull(),
  billToState: text('bill_to_state').notNull(),
  billToZip: text('bill_to_zip').notNull(),
  billToCountryISO: text('bill_to_country_as_iso').notNull(),
  billToIsUSResidential: integer('bill_to_is_us_residential').default(0),

  shipToName: text('ship_to_name').notNull(),
  shipToStreet1: text('ship_to_street_1').notNull(),
  shipToStreet2: text('ship_to_street_2'),
  shipToStreet3: text('ship_to_street_3'),
  shipToCity: text('ship_to_city').notNull(),
  shipToState: text('ship_to_state').notNull(),
  shipToZip: text('ship_to_zip').notNull(),
  shipToCountryISO: text('ship_to_country_as_iso').notNull(),
  shipToIsUSResidential: integer('ship_to_is_us_residential').default(0),
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

export const signUpSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
});


export const signInSchema = z.object({
	email: z.string().email(),
	password: z.string()
})

export const idSchema = z.object({
	id: z.number().int(),
});


export const orderSchema = z
	.object({
		email: z.string().email(), // Assuming email should be a valid email string
		phone: z.string(),
		name: z.string(),
		orderNumber: z.string(),
		filename: z.string(),
		fileURL: z.string().url(), // Assuming fileURL should be a valid URL
		bill_to_street_1: z.string(),
		bill_to_street_2: z.string(),
		bill_to_street_3: z.string(),
		bill_to_city: z.string(),
		bill_to_state: z.string(),
		bill_to_zip: z.string(),
		bill_to_country_as_iso: z.string(),
		bill_to_is_US_residential: z.string(),
		ship_to_name: z.string(),
		ship_to_street_1: z.string(),
		ship_to_street_2: z.string(),
		ship_to_street_3: z.string(),
		ship_to_city: z.string(),
		ship_to_state: z.string(),
		ship_to_zip: z.string(),
		ship_to_country_as_iso: z.string(),
		ship_to_is_US_residential: z.string(),
		order_item_name: z.string(),
		order_quantity: z.string(),
		order_image_url: z.string().url(), // Assuming order_image_url should be a valid URL
		order_sku: z.string(),
		order_item_color: z.string(),
	})
	.strict();

// Schema for adding a new product to the products table
export const addProductSchema = z
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

export const updateProductSchema = z.object({
	id: z.number(),
	name: z.string(),
	description: z.string(),
	image: z.string(),
	stl: z.string(),
	price: z.number(),
	filamentType: z.string(),
	color: z.string(),
	skuNumber: z.string(),
});
