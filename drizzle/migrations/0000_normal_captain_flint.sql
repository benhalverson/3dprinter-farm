CREATE TABLE `account` (
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
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cart` (
	`id` integer PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`sku_number` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`color` text DEFAULT '#000000',
	`filament_type` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `category` (
	`categoryId` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`categoryName` text NOT NULL
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
	`user_id` text NOT NULL,
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
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`image` text DEFAULT '',
	`image_gallery` text,
	`stl` text NOT NULL,
	`price` real DEFAULT 0 NOT NULL,
	`filament_type` text DEFAULT 'PLA' NOT NULL,
	`sku_number` text DEFAULT '',
	`color` text DEFAULT '#000000',
	`stripe_product_id` text,
	`stripe_price_id` text,
	`public_file_service_id` text,
	`categoryId` integer,
	FOREIGN KEY (`categoryId`) REFERENCES `category`(`categoryId`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `products_to_categories` (
	`product_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`order_index` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`product_id`, `category_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `category`(`categoryId`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `uploaded_files` (
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploaded_files_public_file_service_id_unique` ON `uploaded_files` (`public_file_service_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
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
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);
