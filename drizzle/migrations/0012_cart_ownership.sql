CREATE TABLE `shopping_carts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`guest_token_hash` text,
	`access_version` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shopping_carts_access_version_unique` ON `shopping_carts` (`access_version`);--> statement-breakpoint
ALTER TABLE `cart` ADD `access_version` text;--> statement-breakpoint
CREATE UNIQUE INDEX `cart_configuration_unique` ON `cart` (`access_version`,`sku_number`,`filament_id`);