CREATE TABLE `order_notification_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`notification_type` text NOT NULL,
	`recipient_email` text NOT NULL,
	`status` text NOT NULL,
	`provider_message_id` text,
	`error_message` text,
	`status_transition` text,
	`source` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE cascade
);
