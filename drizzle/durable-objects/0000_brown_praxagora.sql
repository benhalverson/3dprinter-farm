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
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`invocation` integer NOT NULL,
	`model` text NOT NULL,
	`price_version` text NOT NULL,
	`input_rate` integer NOT NULL,
	`output_rate` integer NOT NULL,
	`maximum` integer NOT NULL,
	`charged` integer NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer
);
--> statement-breakpoint
CREATE INDEX `reservation_month` ON `reservations` (`month`);--> statement-breakpoint
CREATE TABLE `starts` (
	`id` text PRIMARY KEY NOT NULL,
	`visitor` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `visitor_starts` ON `starts` (`visitor`,`at`);--> statement-breakpoint
CREATE TABLE `shopping_pending_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE TABLE `visit` (
	`id` text PRIMARY KEY NOT NULL,
	`capability` text NOT NULL,
	`created` integer NOT NULL,
	`touched` integer NOT NULL,
	`visitor` text NOT NULL
);
