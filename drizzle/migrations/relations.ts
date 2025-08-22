import { relations } from "drizzle-orm/relations";
import { users, authenticators, webauthnChallenges, ordersTable } from "./schema";

export const authenticatorsRelations = relations(authenticators, ({one}) => ({
	user: one(users, {
		fields: [authenticators.userId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	authenticators: many(authenticators),
	webauthnChallenges: many(webauthnChallenges),
	ordersTables: many(ordersTable),
}));

export const webauthnChallengesRelations = relations(webauthnChallenges, ({one}) => ({
	user: one(users, {
		fields: [webauthnChallenges.userId],
		references: [users.id]
	}),
}));

export const ordersTableRelations = relations(ordersTable, ({one}) => ({
	user: one(users, {
		fields: [ordersTable.userId],
		references: [users.id]
	}),
}));