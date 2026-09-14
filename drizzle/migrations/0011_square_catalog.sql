CREATE TABLE `order_cancellation_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`actor_id` text,
	`actor_email` text,
	`reason` text,
	`override` integer DEFAULT false NOT NULL,
	`slant_status` text,
	`slant_result` text,
	`stripe_refund_id` text,
	`stripe_refund_status` text,
	`stripe_result` text,
	`final_status` text NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `order_reconciliation_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`trigger_source` text NOT NULL,
	`starting_state` text NOT NULL,
	`detected_issue_type` text,
	`actions_taken` text,
	`result_status` text NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `square_catalog_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` integer,
	`catalog_id` integer NOT NULL,
	`environment` text NOT NULL,
	`merchant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`item_id` text,
	`variation_id` text,
	`published` integer DEFAULT 0 NOT NULL,
	`published_snapshot` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `square_catalog_mappings_product_id_unique` ON `square_catalog_mappings` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `square_catalog_item` ON `square_catalog_mappings` (`environment`,`merchant_id`,`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `square_catalog_variation` ON `square_catalog_mappings` (`environment`,`merchant_id`,`variation_id`);--> statement-breakpoint
CREATE TABLE `square_catalog_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`mapping_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`snapshot` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`generation` integer NOT NULL,
	FOREIGN KEY (`mapping_id`) REFERENCES `square_catalog_mappings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `square_catalog_one_pending` ON `square_catalog_operations` (`mapping_id`) WHERE "square_catalog_operations"."state" = 'pending';--> statement-breakpoint
ALTER TABLE `order_events` ADD `external_event_id` text;--> statement-breakpoint
ALTER TABLE `order_events` ADD `source` text DEFAULT 'admin';--> statement-breakpoint
ALTER TABLE `order_events` ADD `previous_status` text;--> statement-breakpoint
ALTER TABLE `order_events` ADD `next_status` text;--> statement-breakpoint
ALTER TABLE `order_events` ADD `metadata` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `cart_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `stripe_event_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `total_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `currency` text DEFAULT 'usd';--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `item_snapshot` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `customer_snapshot` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `processed_at` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `shipped_at` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `delivered_at` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `canceled_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `in_person_price_cents` integer;--> statement-breakpoint
ALTER TABLE `products` ADD `square_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `stripe_product_id`;