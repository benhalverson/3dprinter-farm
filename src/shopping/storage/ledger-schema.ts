import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Append-only: a conflicting next revision rolls back the entire accounting batch.
export const accountingRevisions = sqliteTable(
  'shopping_accounting_revisions',
  {
    revision: integer().primaryKey(),
  },
);

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

export const budgetAlerts = sqliteTable('shopping_budget_alerts', {
  id: text().primaryKey(),
  month: text().notNull(),
  threshold: integer().notNull(),
  charged: integer().notNull(),
  exhausted: integer({ mode: 'boolean' }).notNull(),
  attempts: integer().notNull().default(0),
  nextAttempt: integer('next_attempt').notNull(),
  lease: text(),
  sender: text(),
  recipient: text(),
  messageId: text('message_id'),
});
