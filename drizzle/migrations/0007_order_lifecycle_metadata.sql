ALTER TABLE `ordersTable` ADD `cart_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `stripe_event_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `total_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `currency` text DEFAULT 'usd';--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `item_snapshot` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `customer_snapshot` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `processed_at` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `shipped_at` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `delivered_at` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `canceled_at` text;--> statement-breakpoint
ALTER TABLE `order_events` ADD `external_event_id` text;--> statement-breakpoint
ALTER TABLE `order_events` ADD `source` text DEFAULT 'admin';--> statement-breakpoint
ALTER TABLE `order_events` ADD `previous_status` text;--> statement-breakpoint
ALTER TABLE `order_events` ADD `next_status` text;--> statement-breakpoint
ALTER TABLE `order_events` ADD `metadata` text;
