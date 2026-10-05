import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const reservations = sqliteTable(
  'reservations',
  {
    id: text().primaryKey(),
    month: text().notNull(),
    sessionId: text('session_id').notNull(),
    runId: text('run_id').notNull(),
    invocation: integer().notNull(),
    model: text().notNull(),
    priceVersion: text('price_version').notNull(),
    inputRate: integer('input_rate').notNull(),
    outputRate: integer('output_rate').notNull(),
    maximum: integer().notNull(),
    charged: integer().notNull(),
    status: text().notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
  },
  table => [index('reservation_month').on(table.month)],
);
export const starts = sqliteTable(
  'starts',
  {
    id: text().primaryKey(),
    visitor: text().notNull(),
    at: integer().notNull(),
  },
  table => [index('visitor_starts').on(table.visitor, table.at)],
);
