ALTER TABLE `category` ADD `normalized_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `category_normalized_key_unique` ON `category` (`normalized_key`);--> statement-breakpoint
ALTER TABLE `product_drafts` ADD `category_confirmation_token` text;--> statement-breakpoint
ALTER TABLE `product_drafts` ADD `category_confirmation_name` text;--> statement-breakpoint
ALTER TABLE `product_drafts` ADD `category_confirmation_key` text;--> statement-breakpoint
ALTER TABLE `product_drafts` ADD `category_confirmation_id` integer;