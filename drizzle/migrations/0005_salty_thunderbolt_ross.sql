CREATE TABLE `order_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`type` text NOT NULL,
	`detail` text,
	`actor` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `status` text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `slant_status` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `slant_public_order_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `stripe_checkout_session_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `stripe_payment_intent_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `customer_email` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `created_at` text DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `updated_at` text DEFAULT CURRENT_TIMESTAMP;