CREATE TABLE `order_cancellation_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`actor_id` text,
	`actor_email` text,
	`reason` text,
	`override` integer DEFAULT false NOT NULL,
	`slant_status` text,
	`slant_result` text,
	`stripe_refund_id` text,
	`stripe_refund_status` text,
	`stripe_result` text,
	`final_status` text NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE cascade
);
