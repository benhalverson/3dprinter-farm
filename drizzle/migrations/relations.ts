import { relations } from "drizzle-orm/relations";
import { users, authenticators, orders, webauthnChallenges } from "./schema";

export const authenticatorsRelations = relations(authenticators, ({one}) => ({
	user: one(users, {
		fields: [authenticators.userId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	authenticators: many(authenticators),
	orders: many(orders),
	webauthnChallenges: many(webauthnChallenges),
}));

export const ordersRelations = relations(orders, ({one}) => ({
	user: one(users, {
		fields: [orders.userId],
		references: [users.id]
	}),
}));

export const webauthnChallengesRelations = relations(webauthnChallenges, ({one}) => ({
	user: one(users, {
		fields: [webauthnChallenges.userId],
		references: [users.id]
	}),
}));