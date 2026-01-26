import { relations } from "drizzle-orm/relations";
import { users, authenticators, ordersTable, webauthnChallenges, category, products, productsToCategories } from "./schema";

export const authenticatorsRelations = relations(authenticators, ({one}) => ({
	user: one(users, {
		fields: [authenticators.userId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	authenticators: many(authenticators),
	ordersTables: many(ordersTable),
	webauthnChallenges: many(webauthnChallenges),
}));

export const ordersTableRelations = relations(ordersTable, ({one}) => ({
	user: one(users, {
		fields: [ordersTable.userId],
		references: [users.id]
	}),
}));

export const webauthnChallengesRelations = relations(webauthnChallenges, ({one}) => ({
	user: one(users, {
		fields: [webauthnChallenges.userId],
		references: [users.id]
	}),
}));

export const productsRelations = relations(products, ({one, many}) => ({
	category: one(category, {
		fields: [products.categoryId],
		references: [category.categoryId]
	}),
	productsToCategories: many(productsToCategories),
}));

export const categoryRelations = relations(category, ({many}) => ({
	products: many(products),
	productsToCategories: many(productsToCategories),
}));

export const productsToCategoriesRelations = relations(productsToCategories, ({one}) => ({
	category: one(category, {
		fields: [productsToCategories.categoryId],
		references: [category.categoryId]
	}),
	product: one(products, {
		fields: [productsToCategories.productId],
		references: [products.id]
	}),
}));