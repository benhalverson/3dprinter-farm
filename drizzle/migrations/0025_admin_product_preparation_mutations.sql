CREATE TABLE `product_mutation_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`preparation_id` text NOT NULL,
	`draft_revision` integer NOT NULL,
	`action` text NOT NULL,
	`state` text NOT NULL,
	`preparation` text NOT NULL,
	`payload` text NOT NULL,
	`square_result` text,
	`environment` text NOT NULL,
	`merchant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`mapping_id` text,
	`mapping_generation` integer,
	`product_id` integer,
	`error` text,
	`replayed` integer DEFAULT 0 NOT NULL,
	`completion_token` text,
	`image_payload` text,
	`result_image_id` text,
	`cleanup` text DEFAULT '[]' NOT NULL,
	`local_error` text,
	`result_item_id` text,
	`result_variation_id` text,
	`local_id` integer,
	`local_name` text NOT NULL,
	`local_description` text NOT NULL,
	`local_image` text NOT NULL,
	`local_image_gallery` text NOT NULL,
	`local_stl` text NOT NULL,
	`local_price` real NOT NULL,
	`local_markup_percentage` real,
	`local_filament_type` text NOT NULL,
	`local_sku_number` text NOT NULL,
	`local_color` text NOT NULL,
	`local_in_person_price` integer NOT NULL,
	`local_public_file_service_id` text NOT NULL,
	`local_category_id` integer,
	`local_square_revision` integer NOT NULL,
	`local_published` integer DEFAULT 1 NOT NULL,
	`local_published_snapshot` text NOT NULL,
	`local_created_at` text NOT NULL,
	`local_null` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_mutation_operations_preparation_id_unique` ON `product_mutation_operations` (`preparation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_mutation_one_live_draft` ON `product_mutation_operations` (`draft_id`) WHERE "product_mutation_operations"."state" <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX `product_mutation_one_live_product` ON `product_mutation_operations` (`product_id`) WHERE "product_mutation_operations"."state" in ('prepared', 'pending', 'item_confirmed', 'square_confirmed', 'repair_required');--> statement-breakpoint
ALTER TABLE `product_drafts` ADD `preparation` text;--> statement-breakpoint
ALTER TABLE `products` ADD `markup_percentage` real;--> statement-breakpoint
ALTER TABLE `products` ADD `catalog_mutation_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `products_catalog_mutation_id_unique` ON `products` (`catalog_mutation_id`);