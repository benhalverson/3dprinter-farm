CREATE TABLE `cart_agent_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`revision` integer NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `shopping_carts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `shopping_carts` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shopping_carts` ADD `mutation_token` text;