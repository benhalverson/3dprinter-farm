PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_account`("id", "account_id", "provider_id", "user_id", "access_token", "refresh_token", "id_token", "access_token_expires_at", "refresh_token_expires_at", "scope", "password", "created_at", "updated_at") SELECT "id", "account_id", "provider_id", "user_id", "access_token", "refresh_token", "id_token", "access_token_expires_at", "refresh_token_expires_at", "scope", "password", "created_at", "updated_at" FROM `account`;--> statement-breakpoint
DROP TABLE `account`;--> statement-breakpoint
ALTER TABLE `__new_account` RENAME TO `account`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_order_cancellation_attempts` (
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
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_order_cancellation_attempts`("id", "order_id", "actor_id", "actor_email", "reason", "override", "slant_status", "slant_result", "stripe_refund_id", "stripe_refund_status", "stripe_result", "final_status", "error_message", "created_at", "updated_at") SELECT "id", "order_id", "actor_id", "actor_email", "reason", "override", "slant_status", "slant_result", "stripe_refund_id", "stripe_refund_status", "stripe_result", "final_status", "error_message", "created_at", "updated_at" FROM `order_cancellation_attempts`;--> statement-breakpoint
DROP TABLE `order_cancellation_attempts`;--> statement-breakpoint
ALTER TABLE `__new_order_cancellation_attempts` RENAME TO `order_cancellation_attempts`;--> statement-breakpoint
CREATE TABLE `__new_order_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`type` text NOT NULL,
	`detail` text,
	`actor` text,
	`external_event_id` text,
	`source` text DEFAULT 'admin',
	`previous_status` text,
	`next_status` text,
	`metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_order_events`("id", "order_id", "type", "detail", "actor", "external_event_id", "source", "previous_status", "next_status", "metadata", "created_at") SELECT "id", "order_id", "type", "detail", "actor", "external_event_id", "source", "previous_status", "next_status", "metadata", "created_at" FROM `order_events`;--> statement-breakpoint
DROP TABLE `order_events`;--> statement-breakpoint
ALTER TABLE `__new_order_events` RENAME TO `order_events`;--> statement-breakpoint
CREATE TABLE `__new_order_notification_attempts` (
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
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_order_notification_attempts`("id", "order_id", "notification_type", "recipient_email", "status", "provider_message_id", "error_message", "status_transition", "source", "idempotency_key", "created_at", "updated_at", "sent_at") SELECT "id", "order_id", "notification_type", "recipient_email", "status", "provider_message_id", "error_message", "status_transition", "source", "idempotency_key", "created_at", "updated_at", "sent_at" FROM `order_notification_attempts`;--> statement-breakpoint
DROP TABLE `order_notification_attempts`;--> statement-breakpoint
ALTER TABLE `__new_order_notification_attempts` RENAME TO `order_notification_attempts`;--> statement-breakpoint
CREATE TABLE `__new_order_reconciliation_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`trigger_source` text NOT NULL,
	`starting_state` text NOT NULL,
	`detected_issue_type` text,
	`actions_taken` text,
	`result_status` text NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_order_reconciliation_attempts`("id", "order_id", "trigger_source", "starting_state", "detected_issue_type", "actions_taken", "result_status", "error_message", "created_at", "updated_at") SELECT "id", "order_id", "trigger_source", "starting_state", "detected_issue_type", "actions_taken", "result_status", "error_message", "created_at", "updated_at" FROM `order_reconciliation_attempts`;--> statement-breakpoint
DROP TABLE `order_reconciliation_attempts`;--> statement-breakpoint
ALTER TABLE `__new_order_reconciliation_attempts` RENAME TO `order_reconciliation_attempts`;--> statement-breakpoint
CREATE TABLE `__new_ordersTable` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`order_number` text NOT NULL,
	`cart_id` text,
	`filename` text,
	`file_url` text NOT NULL,
	`ship_to_name` text NOT NULL,
	`ship_to_street_1` text NOT NULL,
	`ship_to_street_2` text,
	`ship_to_city` text NOT NULL,
	`ship_to_state` text NOT NULL,
	`ship_to_zip` text NOT NULL,
	`ship_to_country_iso` text NOT NULL,
	`bill_to_street_1` text,
	`bill_to_street_2` text,
	`bill_to_city` text,
	`bill_to_state` text,
	`bill_to_zip` text,
	`bill_to_country_iso` text,
	`status` text DEFAULT 'pending',
	`slant_status` text,
	`slant_public_order_id` text,
	`stripe_checkout_session_id` text,
	`stripe_payment_intent_id` text,
	`stripe_event_id` text,
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
INSERT INTO `__new_ordersTable`("id", "user_id", "order_number", "cart_id", "filename", "file_url", "ship_to_name", "ship_to_street_1", "ship_to_street_2", "ship_to_city", "ship_to_state", "ship_to_zip", "ship_to_country_iso", "bill_to_street_1", "bill_to_street_2", "bill_to_city", "bill_to_state", "bill_to_zip", "bill_to_country_iso", "status", "slant_status", "slant_public_order_id", "stripe_checkout_session_id", "stripe_payment_intent_id", "stripe_event_id", "customer_email", "total_amount_cents", "currency", "item_snapshot", "customer_snapshot", "created_at", "updated_at", "processed_at", "shipped_at", "delivered_at", "canceled_at") SELECT "id", "user_id", "order_number", "cart_id", "filename", "file_url", "ship_to_name", "ship_to_street_1", "ship_to_street_2", "ship_to_city", "ship_to_state", "ship_to_zip", "ship_to_country_iso", "bill_to_street_1", "bill_to_street_2", "bill_to_city", "bill_to_state", "bill_to_zip", "bill_to_country_iso", "status", "slant_status", "slant_public_order_id", "stripe_checkout_session_id", "stripe_payment_intent_id", "stripe_event_id", "customer_email", "total_amount_cents", "currency", "item_snapshot", "customer_snapshot", "created_at", "updated_at", "processed_at", "shipped_at", "delivered_at", "canceled_at" FROM `ordersTable`;--> statement-breakpoint
DROP TABLE `ordersTable`;--> statement-breakpoint
ALTER TABLE `__new_ordersTable` RENAME TO `ordersTable`;--> statement-breakpoint
CREATE UNIQUE INDEX `ordersTable_order_number_unique` ON `ordersTable` (`order_number`);--> statement-breakpoint
CREATE TABLE `__new_products_to_categories` (
	`product_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`order_index` integer,
	`created_at` text NOT NULL,
	PRIMARY KEY(`product_id`, `category_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `category`(`categoryId`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_products_to_categories`("product_id", "category_id", "order_index", "created_at") SELECT "product_id", "category_id", "order_index", "created_at" FROM `products_to_categories`;--> statement-breakpoint
DROP TABLE `products_to_categories`;--> statement-breakpoint
ALTER TABLE `__new_products_to_categories` RENAME TO `products_to_categories`;--> statement-breakpoint
CREATE TABLE `__new_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`active_organization_id` text,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_session`("id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id", "impersonated_by") SELECT "id", "expires_at", "token", "created_at", "updated_at", "ip_address", "user_agent", "user_id", "active_organization_id", "impersonated_by" FROM `session`;--> statement-breakpoint
DROP TABLE `session`;--> statement-breakpoint
ALTER TABLE `__new_session` RENAME TO `session`;--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `__new_stripe_fulfillment` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`stripe_event_id` text NOT NULL,
	`stripe_object_id` text NOT NULL,
	`cart_id` text NOT NULL,
	`status` text DEFAULT 'processed' NOT NULL,
	`slant_order_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_stripe_fulfillment`("idempotency_key", "stripe_event_id", "stripe_object_id", "cart_id", "status", "slant_order_id", "created_at", "updated_at") SELECT "idempotency_key", "stripe_event_id", "stripe_object_id", "cart_id", "status", "slant_order_id", "created_at", "updated_at" FROM `stripe_fulfillment`;--> statement-breakpoint
DROP TABLE `stripe_fulfillment`;--> statement-breakpoint
ALTER TABLE `__new_stripe_fulfillment` RENAME TO `stripe_fulfillment`;--> statement-breakpoint
CREATE TABLE `__new_uploaded_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`public_file_service_id` text NOT NULL,
	`file_name` text NOT NULL,
	`file_url` text NOT NULL,
	`dimension_x` real,
	`dimension_y` real,
	`dimension_z` real,
	`volume` real,
	`weight` real,
	`surface_area` real,
	`default_filament_id` text DEFAULT '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
	`estimated_cost` real,
	`estimated_quantity` integer DEFAULT 1,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_uploaded_files`("id", "user_id", "public_file_service_id", "file_name", "file_url", "dimension_x", "dimension_y", "dimension_z", "volume", "weight", "surface_area", "default_filament_id", "estimated_cost", "estimated_quantity", "created_at", "updated_at") SELECT "id", "user_id", "public_file_service_id", "file_name", "file_url", "dimension_x", "dimension_y", "dimension_z", "volume", "weight", "surface_area", "default_filament_id", "estimated_cost", "estimated_quantity", "created_at", "updated_at" FROM `uploaded_files`;--> statement-breakpoint
DROP TABLE `uploaded_files`;--> statement-breakpoint
ALTER TABLE `__new_uploaded_files` RENAME TO `uploaded_files`;--> statement-breakpoint
CREATE UNIQUE INDEX `uploaded_files_public_file_service_id_unique` ON `uploaded_files` (`public_file_service_id`);--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`shipping_address` text DEFAULT '' NOT NULL,
	`billing_address` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`zip_code` text DEFAULT '' NOT NULL,
	`country` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'user' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "name", "email", "email_verified", "image", "created_at", "updated_at", "first_name", "last_name", "shipping_address", "billing_address", "city", "state", "zip_code", "country", "phone", "role") SELECT "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "first_name", "last_name", "shipping_address", "billing_address", "city", "state", "zip_code", "country", "phone", "role" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `__new_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_verification`("id", "identifier", "value", "expires_at", "created_at", "updated_at") SELECT "id", "identifier", "value", "expires_at", "created_at", "updated_at" FROM `verification`;--> statement-breakpoint
DROP TABLE `verification`;--> statement-breakpoint
ALTER TABLE `__new_verification` RENAME TO `verification`;