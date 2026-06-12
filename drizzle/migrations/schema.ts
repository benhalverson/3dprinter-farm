import { sqliteTable, AnySQLiteColumn, foreignKey, text, integer, uniqueIndex, real, primaryKey } from "drizzle-orm/sqlite-core"
  import { sql } from "drizzle-orm"

export const account = sqliteTable("account", {
	id: text().primaryKey().notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" } ),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: integer("access_token_expires_at"),
	refreshTokenExpiresAt: integer("refresh_token_expires_at"),
	scope: text(),
	password: text(),
	createdAt: integer("created_at").default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`).notNull(),
	updatedAt: integer("updated_at").default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`).notNull(),
});

export const category = sqliteTable("category", {
	categoryId: integer().primaryKey({ autoIncrement: true }).notNull(),
	categoryName: text().notNull(),
});

export const leads = sqliteTable("leads", {
	id: integer().primaryKey().notNull(),
	email: text(),
	name: text().notNull(),
	status: text(),
	confirmedAt: integer("confirmed_at"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at"),
},
(table) => [
	uniqueIndex("leads_email_unique").on(table.email),
]);

export const ordersTable = sqliteTable("ordersTable", {
	id: integer().primaryKey().notNull(),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" } ),
	orderNumber: text("order_number").notNull(),
	filename: text(),
	fileUrl: text("file_url").notNull(),
	shipToName: text("ship_to_name").notNull(),
	shipToStreet1: text("ship_to_street_1").notNull(),
	shipToStreet2: text("ship_to_street_2"),
	shipToCity: text("ship_to_city").notNull(),
	shipToState: text("ship_to_state").notNull(),
	shipToZip: text("ship_to_zip").notNull(),
	shipToCountryIso: text("ship_to_country_iso").notNull(),
	billToStreet1: text("bill_to_street_1"),
	billToStreet2: text("bill_to_street_2"),
	billToCity: text("bill_to_city"),
	billToState: text("bill_to_state"),
	billToZip: text("bill_to_zip"),
	billToCountryIso: text("bill_to_country_iso"),
},
(table) => [
	uniqueIndex("ordersTable_order_number_unique").on(table.orderNumber),
]);

export const passkey = sqliteTable("passkey", {
	id: text().primaryKey().notNull(),
	name: text(),
	publicKey: text("public_key").notNull(),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" } ),
	credentialId: text("credential_id").notNull(),
	counter: integer().notNull(),
	deviceType: text("device_type").notNull(),
	backedUp: integer("backed_up").notNull(),
	transports: text(),
	createdAt: integer("created_at"),
	aaguid: text(),
});

export const products = sqliteTable("products", {
	id: integer().primaryKey({ autoIncrement: true }).notNull(),
	name: text().notNull(),
	description: text().notNull(),
	image: text().default(""),
	imageGallery: text("image_gallery"),
	stl: text().notNull(),
	price: real().notNull(),
	filamentType: text("filament_type").default("PLA").notNull(),
	skuNumber: text("sku_number").default(""),
	color: text().default("#000000"),
	stripeProductId: text("stripe_product_id"),
	stripePriceId: text("stripe_price_id"),
	publicFileServiceId: text("public_file_service_id"),
	categoryId: integer().references(() => category.categoryId),
});

export const session = sqliteTable("session", {
	id: text().primaryKey().notNull(),
	expiresAt: integer("expires_at").notNull(),
	token: text().notNull(),
	createdAt: integer("created_at").default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`).notNull(),
	updatedAt: integer("updated_at").default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" } ),
	impersonatedBy: text("impersonated_by"),
	activeOrganizationId: text("active_organization_id"),
},
(table) => [
	uniqueIndex("session_token_unique").on(table.token),
]);

export const uploadedFiles = sqliteTable("uploaded_files", {
	id: integer().primaryKey({ autoIncrement: true }).notNull(),
	userId: text("user_id").references(() => users.id, { onDelete: "cascade" } ),
	publicFileServiceId: text("public_file_service_id").notNull(),
	fileName: text("file_name").notNull(),
	fileUrl: text("file_url").notNull(),
	dimensionX: real("dimension_x"),
	dimensionY: real("dimension_y"),
	dimensionZ: real("dimension_z"),
	volume: real(),
	weight: real(),
	surfaceArea: real("surface_area"),
	defaultFilamentId: text("default_filament_id").default("76fe1f79-3f1e-43e4-b8f4-61159de5b93c"),
	estimatedCost: real("estimated_cost"),
	estimatedQuantity: integer("estimated_quantity").default(1),
	createdAt: integer("created_at").default(sql`(unixepoch())`).notNull(),
	updatedAt: integer("updated_at").default(sql`(unixepoch())`).notNull(),
},
(table) => [
	uniqueIndex("uploaded_files_public_file_service_id_unique").on(table.publicFileServiceId),
]);

export const users = sqliteTable("users", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	emailVerified: integer("email_verified").default(false).notNull(),
	image: text(),
	createdAt: integer("created_at").default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`).notNull(),
	updatedAt: integer("updated_at").default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`).notNull(),
	firstName: text("first_name").default("").notNull(),
	lastName: text("last_name").default("").notNull(),
	shippingAddress: text("shipping_address").default("").notNull(),
	billingAddress: text("billing_address").default("").notNull(),
	city: text().default("").notNull(),
	state: text().default("").notNull(),
	zipCode: text("zip_code").default("").notNull(),
	country: text().default("").notNull(),
	phone: text().default("").notNull(),
	role: text().default("user").notNull(),
},
(table) => [
	uniqueIndex("users_email_unique").on(table.email),
]);

export const verification = sqliteTable("verification", {
	id: text().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: integer("expires_at").notNull(),
	createdAt: integer("created_at").default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
	updatedAt: integer("updated_at").default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
});

export const invitation = sqliteTable("invitation", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" } ),
	email: text().notNull(),
	role: text().notNull(),
	status: text().default("pending").notNull(),
	inviterId: text("inviter_id").notNull().references(() => users.id, { onDelete: "cascade" } ),
	expiresAt: integer("expires_at"),
	createdAt: integer("created_at").notNull(),
});

export const member = sqliteTable("member", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" } ),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" } ),
	role: text().default("member").notNull(),
	createdAt: integer("created_at").notNull(),
});

export const organization = sqliteTable("organization", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	logo: text(),
	metadata: text(),
	createdAt: integer("created_at").notNull(),
},
(table) => [
	uniqueIndex("organization_slug_unique").on(table.slug),
]);

export const productsToCategories = sqliteTable("products_to_categories", {
	productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade", onUpdate: "cascade" } ),
	categoryId: integer("category_id").notNull().references(() => category.categoryId, { onDelete: "set null", onUpdate: "cascade" } ),
	orderIndex: integer("order_index"),
	createdAt: text("created_at").default("sql`(CURRENT_TIMESTAMP)`").notNull(),
},
(table) => [
	primaryKey({ columns: [table.productId, table.categoryId], name: "products_to_categories_product_id_category_id_pk"})
]);

export const cart = sqliteTable("cart", {
	id: integer().primaryKey().notNull(),
	cartId: text("cart_id").notNull(),
	userId: text("user_id").references(() => users.id, { onDelete: "set null" } ),
	skuNumber: text("sku_number").notNull(),
	quantity: integer().default(1).notNull(),
	color: text().default("#000000"),
	filamentType: text("filament_type").notNull(),
	filamentId: text("filament_id").default("76fe1f79-3f1e-43e4-b8f4-61159de5b93c"),
});

