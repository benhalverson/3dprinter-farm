CREATE TABLE `orders` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`order_number` text NOT NULL,
	`filename` text,
	`file_url` text NOT NULL,
	`bill_to_street_1` text NOT NULL,
	`bill_to_street_2` text,
	`bill_to_street_3` text,
	`bill_to_city` text NOT NULL,
	`bill_to_state` text NOT NULL,
	`bill_to_zip` text NOT NULL,
	`bill_to_country_as_iso` text NOT NULL,
	`bill_to_is_us_residential` integer DEFAULT 0,
	`ship_to_name` text NOT NULL,
	`ship_to_street_1` text NOT NULL,
	`ship_to_street_2` text,
	`ship_to_street_3` text,
	`ship_to_city` text NOT NULL,
	`ship_to_state` text NOT NULL,
	`ship_to_zip` text NOT NULL,
	`ship_to_country_as_iso` text NOT NULL,
	`ship_to_is_us_residential` integer DEFAULT 0,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_unique` ON `orders` (`order_number`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`image` text DEFAULT '',
	`stl` text NOT NULL,
	`price` real DEFAULT 0 NOT NULL,
	`filament_type` text DEFAULT 'PLA' NOT NULL,
	`sku_number` text DEFAULT '',
	`color` text DEFAULT '#000000'
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`shipping_address` text NOT NULL,
	`billing_address` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);