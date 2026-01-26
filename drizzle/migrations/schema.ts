import { sql } from 'drizzle-orm';
import {
  AnySQLiteColumn,
  blob,
  foreignKey,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const authenticators = sqliteTable(
  'authenticators',
  {
    id: integer().primaryKey().notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull(),
    credentialPublicKey: blob('credential_public_key').notNull(),
    counter: integer().default(0).notNull(),
  },
  table => [
    uniqueIndex('authenticators_user_credential_unique').on(
      table.userId,
      table.credentialId,
    ),
  ],
);

export const leads = sqliteTable(
  'leads',
  {
    id: integer().primaryKey().notNull(),
    email: text(),
    name: text().notNull(),
    status: text(),
    confirmedAt: integer('confirmed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at'),
  },
  table => [uniqueIndex('leads_email_unique').on(table.email)],
);

export const ordersTable = sqliteTable(
  'ordersTable',
  {
    id: integer().primaryKey().notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orderNumber: text('order_number').notNull(),
    filename: text(),
    fileUrl: text('file_url').notNull(),
    shipToName: text('ship_to_name').notNull(),
    shipToStreet1: text('ship_to_street_1').notNull(),
    shipToStreet2: text('ship_to_street_2'),
    shipToCity: text('ship_to_city').notNull(),
    shipToState: text('ship_to_state').notNull(),
    shipToZip: text('ship_to_zip').notNull(),
    shipToCountryIso: text('ship_to_country_iso').notNull(),
    billToStreet1: text('bill_to_street_1'),
    billToStreet2: text('bill_to_street_2'),
    billToCity: text('bill_to_city'),
    billToState: text('bill_to_state'),
    billToZip: text('bill_to_zip'),
    billToCountryIso: text('bill_to_country_iso'),
  },
  table => [
    uniqueIndex('ordersTable_order_number_unique').on(table.orderNumber),
  ],
);

export const users = sqliteTable(
  'users',
  {
    id: integer().primaryKey().notNull(),
    email: text().notNull(),
    passwordHash: text('password_hash').notNull(),
    salt: text().notNull(),
    firstName: text('first_name').default('').notNull(),
    lastName: text('last_name').default('').notNull(),
    shippingAddress: text('shipping_address').default('').notNull(),
    billingAddress: text('billing_address').default('').notNull(),
    city: text().default('').notNull(),
    state: text().default('').notNull(),
    zipCode: text('zip_code').default('').notNull(),
    country: text().default('').notNull(),
    phone: text().default('').notNull(),
    role: text().default('user').notNull(),
  },
  table => [uniqueIndex('users_email_unique').on(table.email)],
);

export const webauthnChallenges = sqliteTable('webauthn_challenges', {
  userId: integer('user_id')
    .primaryKey()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  challenge: text().notNull(),
});

export const cart = sqliteTable('cart', {
  id: integer().primaryKey().notNull(),
  cartId: text('cart_id').notNull(),
  skuNumber: text('sku_number').notNull(),
  quantity: integer().default(1).notNull(),
  color: text().default('#000000'),
  filamentType: text('filament_type').notNull(),
});

export const category = sqliteTable('category', {
  categoryId: integer().primaryKey({ autoIncrement: true }).notNull(),
  categoryName: text().notNull(),
});

export const products = sqliteTable('products', {
  id: integer().primaryKey({ autoIncrement: true }).notNull(),
  name: text().notNull(),
  description: text().notNull(),
  image: text().default(''),
  imageGallery: text('image_gallery'),
  stl: text().notNull(),
  price: real().notNull(),
  filamentType: text('filament_type').default('PLA').notNull(),
  skuNumber: text('sku_number').default(''),
  color: text().default('#000000'),
  stripeProductId: text('stripe_product_id'),
  stripePriceId: text('stripe_price_id'),
  categoryId: integer().references(() => category.categoryId),
  publicFileServiceId: text('public_file_service_id'),
});

export const productsToCategories = sqliteTable(
  'products_to_categories',
  {
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => category.categoryId, {
        onDelete: 'set null',
        onUpdate: 'cascade',
      }),
    orderIndex: integer('order_index'),
    createdAt: text('created_at').default('sql`(CURRENT_TIMESTAMP)`').notNull(),
  },
  table => [
    primaryKey({
      columns: [table.productId, table.categoryId],
      name: 'products_to_categories_product_id_category_id_pk',
    }),
  ],
);
