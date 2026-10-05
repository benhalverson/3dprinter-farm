CREATE TABLE `checkout_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`cart_id` text NOT NULL,
	`quote_id` text NOT NULL,
	`request_key` text NOT NULL,
	`snapshot` text NOT NULL,
	`customer_email` text NOT NULL,
	`merchant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`state` text DEFAULT 'initiating' NOT NULL,
	`square_order_id` text,
	`payment_link_id` text,
	`payment_url` text,
	`square_payment_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`quote_id`) REFERENCES `checkout_quotes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`quote_id`,`id`) REFERENCES `checkout_quotes`(`id`,`consumed_attempt_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_attempts_quote_id_unique` ON `checkout_attempts` (`quote_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_attempts_request_key_unique` ON `checkout_attempts` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_attempts_square_order_id_unique` ON `checkout_attempts` (`square_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_attempts_payment_link_id_unique` ON `checkout_attempts` (`payment_link_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_attempts_square_payment_id_unique` ON `checkout_attempts` (`square_payment_id`);--> statement-breakpoint
CREATE TABLE `checkout_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`cart_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`encrypted_snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_attempt_id` text,
	`invalidated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `checkout_quotes_owner_cart` ON `checkout_quotes` (`owner_id`,`cart_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_quote_consumption` ON `checkout_quotes` (`id`,`consumed_attempt_id`);--> statement-breakpoint
ALTER TABLE `order_events` ADD `dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `order_events_dedupe_key_unique` ON `order_events` (`dedupe_key`);--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `source` text DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `fulfillment_type` text DEFAULT 'slant' NOT NULL;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `payment_status` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `square_order_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `square_payment_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `checkout_attempt_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `shipping_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `fulfillment_state` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ordersTable_square_order_id_unique` ON `ordersTable` (`square_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ordersTable_square_payment_id_unique` ON `ordersTable` (`square_payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ordersTable_checkout_attempt_id_unique` ON `ordersTable` (`checkout_attempt_id`);