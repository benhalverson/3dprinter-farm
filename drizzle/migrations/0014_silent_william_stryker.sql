CREATE TABLE `product_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`target` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `product_drafts_owner_updated` ON `product_drafts` (`owner_id`,`updated_at`);