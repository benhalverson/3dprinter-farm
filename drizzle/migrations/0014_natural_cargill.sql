CREATE TABLE `shopping_accounting_revisions` (
	`revision` integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shopping_budget_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`threshold` integer NOT NULL,
	`charged` integer NOT NULL,
	`exhausted` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt` integer NOT NULL,
	`lease` text,
	`sender` text,
	`recipient` text,
	`message_id` text
);
--> statement-breakpoint
CREATE TABLE `shopping_pending_usage` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	PRIMARY KEY(`session_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `shopping_runs` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	PRIMARY KEY(`session_id`, `id`)
);
