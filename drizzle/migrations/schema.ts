import { sqliteTable, AnySQLiteColumn, uniqueIndex, foreignKey, integer, text, real } from "drizzle-orm/sqlite-core"
  import { sql } from "drizzle-orm"

export const orders = sqliteTable("orders", {
	id: integer().primaryKey().notNull(),
	userId: integer("user_id").notNull().references(() => users.id),
	orderNumber: text("order_number").notNull(),
	filename: text(),
	fileUrl: text("file_url").notNull(),
	billToStreet1: text("bill_to_street_1").notNull(),
	billToStreet2: text("bill_to_street_2"),
	billToStreet3: text("bill_to_street_3"),
	billToCity: text("bill_to_city").notNull(),
	billToState: text("bill_to_state").notNull(),
	billToZip: text("bill_to_zip").notNull(),
	billToCountryAsIso: text("bill_to_country_as_iso").notNull(),
	billToIsUsResidential: integer("bill_to_is_us_residential").default(0),
	shipToName: text("ship_to_name").notNull(),
	shipToStreet1: text("ship_to_street_1").notNull(),
	shipToStreet2: text("ship_to_street_2"),
	shipToStreet3: text("ship_to_street_3"),
	shipToCity: text("ship_to_city").notNull(),
	shipToState: text("ship_to_state").notNull(),
	shipToZip: text("ship_to_zip").notNull(),
	shipToCountryAsIso: text("ship_to_country_as_iso").notNull(),
	shipToIsUsResidential: integer("ship_to_is_us_residential").default(0),
},
(table) => {
	return {
		orderNumberUnique: uniqueIndex("orders_order_number_unique").on(table.orderNumber),
	}
});

export const users = sqliteTable("users", {
	id: integer().primaryKey().notNull(),
	email: text().notNull(),
	passwordHash: text("password_hash").notNull(),
	firstName: text("first_name").notNull(),
	lastName: text("last_name").notNull(),
	shippingAddress: text("shipping_address").notNull(),
	billingAddress: text("billing_address").notNull(),
	role: text().default("user").notNull(),
},
(table) => {
	return {
		emailUnique: uniqueIndex("users_email_unique").on(table.email),
	}
});

export const products = sqliteTable("products", {
	id: integer().primaryKey({ autoIncrement: true }).notNull(),
	name: text().notNull(),
	description: text().notNull(),
	image: text().default(""),
	stl: text().notNull(),
	price: real().notNull(),
	filamentType: text("filament_type").default("PLA").notNull(),
	skuNumber: text("sku_number").notNull().default("000"),
	color: text().default("#000000"),
});

export const drizzleMigrations = sqliteTable("__drizzle_migrations", {
});

