PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_orders` (
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
INSERT INTO `__new_orders`("id", "user_id", "order_number", "filename", "file_url", "ship_to_name", "ship_to_street_1", "ship_to_street_2", "ship_to_city", "ship_to_state", "ship_to_zip", "ship_to_country_iso", "bill_to_street_1", "bill_to_street_2", "bill_to_city", "bill_to_state", "bill_to_zip", "bill_to_country_iso") SELECT "id", "user_id", "order_number", "filename", "file_url", "ship_to_name", "ship_to_street_1", "ship_to_street_2", "ship_to_city", "ship_to_state", "ship_to_zip", "ship_to_country_iso", "bill_to_street_1", "bill_to_street_2", "bill_to_city", "bill_to_state", "bill_to_zip", "bill_to_country_iso" FROM `orders`;--> statement-breakpoint
DROP TABLE `orders`;--> statement-breakpoint
ALTER TABLE `__new_orders` RENAME TO `orders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_unique` ON `orders` (`order_number`);--> statement-breakpoint
ALTER TABLE `users` ADD `city` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `state` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `zip_code` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `country` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `phone` text;