CREATE TABLE `in_person_sales` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`seller_id` text NOT NULL,
	`request` text NOT NULL,
	`snapshot` text NOT NULL,
	`merchant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`environment` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`square_order_id` text,
	`square_payment_id` text,
	`payment_url` text,
	`payment_link_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `in_person_sales_request_key_unique` ON `in_person_sales` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `in_person_sales_square_order_id_unique` ON `in_person_sales` (`square_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `in_person_sales_square_payment_id_unique` ON `in_person_sales` (`square_payment_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ordersTable` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text,
	`order_number` text NOT NULL,
	`cart_id` text,
	`filename` text,
	`file_url` text,
	`ship_to_name` text,
	`ship_to_street_1` text,
	`ship_to_street_2` text,
	`ship_to_city` text,
	`ship_to_state` text,
	`ship_to_zip` text,
	`ship_to_country_iso` text,
	`bill_to_street_1` text,
	`bill_to_street_2` text,
	`bill_to_city` text,
	`bill_to_state` text,
	`bill_to_zip` text,
	`bill_to_country_iso` text,
	`status` text DEFAULT 'pending',
	`slant_status` text,
	`slant_public_order_id` text,
	`slant_event_key` text,
	`source` text DEFAULT 'online' NOT NULL,
	`fulfillment_type` text DEFAULT 'slant' NOT NULL,
	`payment_status` text,
	`square_order_id` text,
	`square_payment_id` text,
	`checkout_attempt_id` text,
	`shipping_amount_cents` integer,
	`fulfillment_state` text,
	`customer_email` text,
	`total_amount_cents` integer,
	`currency` text DEFAULT 'usd',
	`item_snapshot` text,
	`customer_snapshot` text,
	`created_at` text,
	`updated_at` text,
	`processed_at` text,
	`shipped_at` text,
	`delivered_at` text,
	`canceled_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_ordersTable`("id", "user_id", "order_number", "cart_id", "filename", "file_url", "ship_to_name", "ship_to_street_1", "ship_to_street_2", "ship_to_city", "ship_to_state", "ship_to_zip", "ship_to_country_iso", "bill_to_street_1", "bill_to_street_2", "bill_to_city", "bill_to_state", "bill_to_zip", "bill_to_country_iso", "status", "slant_status", "slant_public_order_id", "slant_event_key", "source", "fulfillment_type", "payment_status", "square_order_id", "square_payment_id", "checkout_attempt_id", "shipping_amount_cents", "fulfillment_state", "customer_email", "total_amount_cents", "currency", "item_snapshot", "customer_snapshot", "created_at", "updated_at", "processed_at", "shipped_at", "delivered_at", "canceled_at") SELECT "id", "user_id", "order_number", "cart_id", "filename", "file_url", "ship_to_name", "ship_to_street_1", "ship_to_street_2", "ship_to_city", "ship_to_state", "ship_to_zip", "ship_to_country_iso", "bill_to_street_1", "bill_to_street_2", "bill_to_city", "bill_to_state", "bill_to_zip", "bill_to_country_iso", "status", "slant_status", "slant_public_order_id", "slant_event_key", "source", "fulfillment_type", "payment_status", "square_order_id", "square_payment_id", "checkout_attempt_id", "shipping_amount_cents", "fulfillment_state", "customer_email", "total_amount_cents", "currency", "item_snapshot", "customer_snapshot", "created_at", "updated_at", "processed_at", "shipped_at", "delivered_at", "canceled_at" FROM `ordersTable`;--> statement-breakpoint
DROP TABLE `ordersTable`;--> statement-breakpoint
ALTER TABLE `__new_ordersTable` RENAME TO `ordersTable`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `ordersTable_order_number_unique` ON `ordersTable` (`order_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `ordersTable_square_order_id_unique` ON `ordersTable` (`square_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ordersTable_square_payment_id_unique` ON `ordersTable` (`square_payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ordersTable_checkout_attempt_id_unique` ON `ordersTable` (`checkout_attempt_id`);