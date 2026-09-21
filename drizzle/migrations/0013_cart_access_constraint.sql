PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cart` (
	`id` integer PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`access_version` text,
	`user_id` text,
	`sku_number` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`color` text DEFAULT '#000000',
	`filament_type` text NOT NULL,
	`filament_id` text DEFAULT '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
	FOREIGN KEY (`access_version`) REFERENCES `shopping_carts`(`access_version`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_cart`("id", "cart_id", "access_version", "user_id", "sku_number", "quantity", "color", "filament_type", "filament_id") SELECT "id", "cart_id", "access_version", "user_id", "sku_number", "quantity", "color", "filament_type", "filament_id" FROM `cart`;--> statement-breakpoint
DROP TABLE `cart`;--> statement-breakpoint
ALTER TABLE `__new_cart` RENAME TO `cart`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `cart_configuration_unique` ON `cart` (`access_version`,`sku_number`,`filament_id`);