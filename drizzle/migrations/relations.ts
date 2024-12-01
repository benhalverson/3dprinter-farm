import { relations } from "drizzle-orm/relations";
import { users, orders } from "./schema";

export const ordersRelations = relations(orders, ({one}) => ({
	user: one(users, {
		fields: [orders.userId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	orders: many(orders),
}));