CREATE TABLE `checkout_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`cart_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`encrypted_snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`invalidated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `checkout_quotes_owner_cart` ON `checkout_quotes` (`owner_id`,`cart_id`);