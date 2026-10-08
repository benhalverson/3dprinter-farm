ALTER TABLE `product_drafts` ADD `creation_request_key` text;--> statement-breakpoint
ALTER TABLE `product_drafts` ADD `creation_input_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `product_drafts_owner_creation_key` ON `product_drafts` (`owner_id`,`creation_request_key`);