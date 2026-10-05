import { relations } from "drizzle-orm/relations";
import { users, account, ordersTable, passkey, category, products, session, uploadedFiles, invitation, organization, member, productsToCategories, cart } from "./schema";

export const accountRelations = relations(account, ({one}) => ({
	user: one(users, {
		fields: [account.userId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	accounts: many(account),
	ordersTables: many(ordersTable),
	passkeys: many(passkey),
	sessions: many(session),
	uploadedFiles: many(uploadedFiles),
	invitations: many(invitation),
	members: many(member),
	carts: many(cart),
}));

export const ordersTableRelations = relations(ordersTable, ({one}) => ({
	user: one(users, {
		fields: [ordersTable.userId],
		references: [users.id]
	}),
}));

export const passkeyRelations = relations(passkey, ({one}) => ({
	user: one(users, {
		fields: [passkey.userId],
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

export const sessionRelations = relations(session, ({one}) => ({
	user: one(users, {
		fields: [session.userId],
		references: [users.id]
	}),
}));

export const uploadedFilesRelations = relations(uploadedFiles, ({one}) => ({
	user: one(users, {
		fields: [uploadedFiles.userId],
		references: [users.id]
	}),
}));

export const invitationRelations = relations(invitation, ({one}) => ({
	user: one(users, {
		fields: [invitation.inviterId],
		references: [users.id]
	}),
	organization: one(organization, {
		fields: [invitation.organizationId],
		references: [organization.id]
	}),
}));

export const organizationRelations = relations(organization, ({many}) => ({
	invitations: many(invitation),
	members: many(member),
}));

export const memberRelations = relations(member, ({one}) => ({
	user: one(users, {
		fields: [member.userId],
		references: [users.id]
	}),
	organization: one(organization, {
		fields: [member.organizationId],
		references: [organization.id]
	}),
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

export const cartRelations = relations(cart, ({one}) => ({
	user: one(users, {
		fields: [cart.userId],
		references: [users.id]
	}),
}));