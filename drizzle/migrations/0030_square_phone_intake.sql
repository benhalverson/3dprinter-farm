CREATE TABLE `square_phone_intake` (
	`payment_id` text PRIMARY KEY NOT NULL,
	`square_order_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`order_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE no action
);
