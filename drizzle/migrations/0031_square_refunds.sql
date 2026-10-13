CREATE TABLE `square_refund_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` integer NOT NULL,
	`payment_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`environment` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`fulfillment_before` text NOT NULL,
	`reason` text,
	`override` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'preparing' NOT NULL,
	`refund_id` text,
	`error` text,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `square_refund_operations_order_id_unique` ON `square_refund_operations` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `square_refund_operations_refund_id_unique` ON `square_refund_operations` (`refund_id`);--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `refund_status` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `refund_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `refunded_at` text;