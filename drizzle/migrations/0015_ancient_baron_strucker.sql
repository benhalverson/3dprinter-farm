CREATE TABLE `product_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`kind` text NOT NULL,
	`object_key` text NOT NULL,
	`provider_id` text,
	`file_url` text,
	`content_type` text,
	`encryption_key` text NOT NULL,
	`references` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_assets_object_key_unique` ON `product_assets` (`object_key`);--> statement-breakpoint
ALTER TABLE `product_drafts` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `product_drafts` ADD `attachments` text;