CREATE TABLE `notification_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`notification_type` text NOT NULL,
	`recipient_email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_message_id` text,
	`error_message` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	`sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_attempts_idempotency_key_unique` ON `notification_attempts` (`idempotency_key`);
