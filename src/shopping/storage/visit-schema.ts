import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const visits = sqliteTable('visit', {
  id: text().primaryKey(),
  capability: text().notNull(),
  created: integer().notNull(),
  touched: integer().notNull(),
  visitor: text().notNull(),
});
// Migration 0011 created this unscoped D1 table. Preserve it without guessing
// ownership for old records; new sessions use the explicitly scoped table below.
export const legacyRuns = sqliteTable('runs', {
  id: text().primaryKey(),
  revision: integer().notNull(),
  status: text().notNull(),
  reason: text(),
});

export const runs = sqliteTable(
  'shopping_runs',
  {
    sessionId: text('session_id').notNull(),
    id: text().notNull(),
    revision: integer().notNull(),
    status: text().notNull(),
    reason: text(),
  },
  table => [primaryKey({ columns: [table.sessionId, table.id] })],
);

export const pendingUsage = sqliteTable(
  'shopping_pending_usage',
  {
    sessionId: text('session_id').notNull(),
    id: text().notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
  },
  table => [primaryKey({ columns: [table.sessionId, table.id] })],
);
