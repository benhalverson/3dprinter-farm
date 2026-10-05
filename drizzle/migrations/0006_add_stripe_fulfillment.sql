CREATE TABLE `stripe_fulfillment` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`stripe_event_id` text NOT NULL,
	`stripe_object_id` text NOT NULL,
	`cart_id` text NOT NULL,
	`status` text DEFAULT 'processed' NOT NULL,
	`slant_order_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);