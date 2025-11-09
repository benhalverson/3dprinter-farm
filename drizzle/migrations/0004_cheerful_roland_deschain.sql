CREATE TABLE `category` (
	`categoryId` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`categoryName` text NOT NULL
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
ALTER TABLE `products` ADD `categoryId` integer REFERENCES category(categoryId);