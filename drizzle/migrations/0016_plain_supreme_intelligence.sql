CREATE TABLE `product_asset_reference_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_ids` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `product_asset_reference_attempts_state` ON `product_asset_reference_attempts` (`state`);--> statement-breakpoint
CREATE INDEX `product_assets_provider_id` ON `product_assets` (`provider_id`);--> statement-breakpoint
CREATE INDEX `product_assets_file_url` ON `product_assets` (`file_url`);--> statement-breakpoint
CREATE INDEX `product_assets_draft_id` ON `product_assets` (`draft_id`);