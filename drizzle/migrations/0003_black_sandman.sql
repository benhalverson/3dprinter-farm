PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cart` (
	`id` integer PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`sku_number` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`color` text DEFAULT '#000000',
	`filament_type` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_cart`("id", "cart_id", "sku_number", "quantity", "color", "filament_type") SELECT "id", "cart_id", "sku_number", "quantity", "color", "filament_type" FROM `cart`;--> statement-breakpoint
DROP TABLE `cart`;--> statement-breakpoint
ALTER TABLE `__new_cart` RENAME TO `cart`;--> statement-breakpoint
PRAGMA foreign_keys=ON;