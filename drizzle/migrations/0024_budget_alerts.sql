CREATE TABLE `budget_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`threshold` integer NOT NULL,
	`charged` integer NOT NULL,
	`exhausted` integer NOT NULL,
	`attempts` integer NOT NULL,
	`next_attempt` integer NOT NULL,
	`lease` text,
	`sender` text,
	`recipient` text,
	`message_id` text
);
--> statement-breakpoint
CREATE INDEX `budget_alert_due` ON `budget_alerts` (`message_id`,`next_attempt`);