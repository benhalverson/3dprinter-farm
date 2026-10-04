import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const visits = sqliteTable('visit', {
  id: text().primaryKey(),
  capability: text().notNull(),
  created: integer().notNull(),
  touched: integer().notNull(),
  visitor: text().notNull(),
});
export const runs = sqliteTable('runs', {
  id: text().primaryKey(),
  revision: integer().notNull(),
  status: text().notNull(),
  reason: text(),
});
