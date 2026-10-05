CREATE TABLE `square_catalog_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` integer,
	`catalog_id` integer NOT NULL,
	`environment` text NOT NULL,
	`merchant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`item_id` text,
	`variation_id` text,
	`published` integer DEFAULT 0 NOT NULL,
	`published_snapshot` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `square_catalog_mappings_product_id_unique` ON `square_catalog_mappings` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `square_catalog_item` ON `square_catalog_mappings` (`environment`,`merchant_id`,`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `square_catalog_variation` ON `square_catalog_mappings` (`environment`,`merchant_id`,`variation_id`);--> statement-breakpoint
CREATE TABLE `square_catalog_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`mapping_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`snapshot` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`generation` integer NOT NULL,
	FOREIGN KEY (`mapping_id`) REFERENCES `square_catalog_mappings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `square_catalog_one_pending` ON `square_catalog_operations` (`mapping_id`) WHERE "square_catalog_operations"."state" = 'pending';--> statement-breakpoint
ALTER TABLE `products` ADD `in_person_price_cents` integer;--> statement-breakpoint
ALTER TABLE `products` ADD `square_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `stripe_product_id`;