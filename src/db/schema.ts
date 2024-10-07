import { integer, sqliteTable, text, real } from 'drizzle-orm/sqlite-core';

export const products = sqliteTable('products', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  image: text('image').default(''),
  stl: text('stl').notNull(),
  price: real('price').default(0).notNull(),
  filamentType: text('filament_type').notNull().default('PLA'),
  color: text('color').default('#000000'),
});

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  shippingAddress: text('shipping_address').notNull(),
  billingAddress: text('billing_address').notNull(),
  role: text('role').default('user').notNull(),
});

export const orders = sqliteTable('orders', {
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
