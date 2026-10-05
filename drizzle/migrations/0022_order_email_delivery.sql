ALTER TABLE `order_notification_attempts` ADD `delivery_key` text;--> statement-breakpoint
ALTER TABLE `order_notification_attempts` ADD `sender_email` text;--> statement-breakpoint
ALTER TABLE `order_notification_attempts` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `order_notification_attempts` ADD `text_content` text;--> statement-breakpoint
ALTER TABLE `order_notification_attempts` ADD `claim_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `order_notification_attempts_delivery_key_unique` ON `order_notification_attempts` (`delivery_key`);