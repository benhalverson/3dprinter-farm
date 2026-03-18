import { relations, sql } from 'drizzle-orm';
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

export const cart = sqliteTable('cart', {
  id: integer('id').primaryKey(),
  cartId: text('cart_id').notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
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
    'Invalid US phone number format',
  );

export const productsTable = sqliteTable('products', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  image: text('image').default(''),
  imageGallery: text('image_gallery'),
  stl: text('stl').notNull(),
  price: real('price').default(0).notNull(),
  filamentType: text('filament_type').notNull().default('PLA'),
  skuNumber: text('sku_number').default(''),
  color: text('color').default('#000000'),
  stripeProductId: text('stripe_product_id'),
  stripePriceId: text('stripe_price_id'),
  publicFileServiceId: text('public_file_service_id'), // Slant3D file UUID for orders
  // Make optional to allow products without categories during transition
  categoryId: integer().references(() => categoryTable.categoryId),
});

export const productRelations = relations(productsTable, ({ many }) => ({
  categoriesLink: many(productsToCategories),
}));

export const categoryTable = sqliteTable('category', {
  categoryId: integer().primaryKey({ autoIncrement: true }),
  categoryName: text().notNull(),
});

export const productsToCategories = sqliteTable(
  'products_to_categories',
  {
    productId: integer('product_id')
      .notNull()
      .references(() => productsTable.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categoryTable.categoryId, {
        onDelete: 'set null',
        onUpdate: 'cascade',
      }),
    orderIndex: integer('order_index'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  t => [primaryKey({ columns: [t.productId, t.categoryId] })],
);

export const productsToCategoriesRelations = relations(
  productsToCategories,
  ({ one }) => ({
    product: one(productsTable, {
      fields: [productsToCategories.productId],
      references: [productsTable.id],
    }),
    category: one(categoryTable, {
      fields: [productsToCategories.categoryId],
      references: [categoryTable.categoryId],
    }),
  }),
);

export const categoryDataSchema = z.object({
  categoryId: z.number(),
  categoryName: z.string(),
});

// Input schema for creating categories (ID auto-increments in DB)
export const addCategorySchema = z.object({
  categoryName: z.string(),
});

export const ProductsDataSchema = z
  .object({
    id: z.number().optional(),
    name: z.string(),
    description: z.string(),
    image: z.string(),
    imageGallery: z.array(z.string()).optional(),
    stl: z.string(),
    price: z.number(),
    filamentType: z.string(),
    color: z.string(),
    skuNumber: z.string(),
    // Use categoryIds for many-to-many relationships; optional for backward-compat
    categoryIds: z.array(z.number().int()).optional(),
  })
  .omit({ id: true, skuNumber: true });

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .default(false)
    .notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
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

export const organizationTable = sqliteTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const memberTable = sqliteTable('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizationTable.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const invitationTable = sqliteTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizationTable.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull(),
  status: text('status').notNull().default('pending'),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  activeOrganizationId: text('active_organization_id'),
  impersonatedBy: text('impersonated_by'),
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', {
    mode: 'timestamp_ms',
  }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', {
    mode: 'timestamp_ms',
  }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
});

export const passkey = sqliteTable('passkey', {
  id: text('id').primaryKey(),
  name: text('name'),
  publicKey: text('public_key').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  credentialID: text('credential_id').notNull(),
  counter: integer('counter').notNull(),
  deviceType: text('device_type').notNull(),
  backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
  transports: text('transports'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }),
  aaguid: text('aaguid'),
});

const OrderDataSchema = z.object({
  id: z.number(),
  userId: z.string(),
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
  userId: text('user_id')
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
  imageGallery: z.array(z.string()).min(1).optional(),
  // Accept multiple categories on create; optional for now to support existing data
  categoryIds: z.array(z.number().int()).optional(),
  // Also allow a single categoryId for convenience (accept number or array)
  categoryId: z.union([z.number().int(), z.array(z.number().int())]).optional(),
});

export const updateProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  price: z.number(),
  filamentType: z.string(),
  color: z.string(),
  image: z.string(),
  imageGallery: z.array(z.string()).min(1).optional(),
  // Allow updating categories; optional so updates can omit category changes
  categoryIds: z.array(z.number().int()).min(1).optional(),
  // Also accept categoryId as array for compatibility
  categoryId: z.array(z.number().int()).min(1).optional(),
});

export const ProfileDataSchema = z.object({
  id: z.string().optional(),
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
  skuNumber: z.string(),
  quantity: z.number().int().min(1).max(69),
  color: z.string(),
  filamentType: z.string(),
});

// Table for storing uploaded STL files with estimates from Slant3D
export const uploadedFilesTable = sqliteTable('uploaded_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').references(() => users.id, {
    onDelete: 'cascade',
  }),
  publicFileServiceId: text('public_file_service_id').notNull().unique(), // Slant3D UUID
  fileName: text('file_name').notNull(),
  fileURL: text('file_url').notNull(), // Slant3D file URL

  // STL Metrics from Slant3D
  dimensionX: real('dimension_x'), // mm
  dimensionY: real('dimension_y'), // mm
  dimensionZ: real('dimension_z'), // mm
  volume: real('volume'), // cubic cm
  weight: real('weight'), // grams
  surfaceArea: real('surface_area'), // square cm

  // Estimate data (default PLA BLACK, quantity 1)
  defaultFilamentId: text('default_filament_id').default(
    '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
  ), // PLA BLACK
  estimatedCost: real('estimated_cost'), // USD
  estimatedQuantity: integer('estimated_quantity').default(1),

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});
