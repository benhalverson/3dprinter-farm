CREATE TABLE `authenticators` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`credential_id` text NOT NULL,
	`credential_public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authenticators_user_credential_unique` ON `authenticators` (`user_id`,`credential_id`);--> statement-breakpoint
CREATE TABLE `cart` (
	`id` integer PRIMARY KEY NOT NULL,
	`cart_id` integer NOT NULL,
	`sku_number` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`color` text DEFAULT '#000000',
	`filament_type` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY NOT NULL,
	`email` text,
	`name` text NOT NULL,
	`status` text,
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_email_unique` ON `leads` (`email`);--> statement-breakpoint
CREATE TABLE `ordersTable` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`order_number` text NOT NULL,
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
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ordersTable_order_number_unique` ON `ordersTable` (`order_number`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`image` text DEFAULT '',
	`stl` text NOT NULL,
	`price` real DEFAULT 0 NOT NULL,
	`filament_type` text DEFAULT 'PLA' NOT NULL,
	`sku_number` text DEFAULT '',
	`color` text DEFAULT '#000000',
	`stripe_product_id` text,
	`stripe_price_id` text
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`salt` text NOT NULL,
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
CREATE TABLE `webauthn_challenges` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
