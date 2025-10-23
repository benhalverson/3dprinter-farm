PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_products` (
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
	`categoryId` integer,
	FOREIGN KEY (`categoryId`) REFERENCES `category`(`categoryId`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_products`("id", "name", "description", "image", "image_gallery", "stl", "price", "filament_type", "sku_number", "color", "stripe_product_id", "stripe_price_id", "categoryId") SELECT "id", "name", "description", "image", "image_gallery", "stl", "price", "filament_type", "sku_number", "color", "stripe_product_id", "stripe_price_id", "categoryId" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
PRAGMA foreign_keys=ON;