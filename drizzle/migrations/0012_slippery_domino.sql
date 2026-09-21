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
	`id` text PRIMARY KEY NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL
);
