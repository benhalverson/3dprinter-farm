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
CREATE INDEX `visitor_starts` ON `starts` (`visitor`,`at`);