ALTER TABLE `ordersTable` ADD `stripe_event_id` text;
--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `stripe_session_id` text;
--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `stripe_payment_intent_id` text;
--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `status` text DEFAULT 'pending_payment' NOT NULL;
--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `cart_id` text;
--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `slant3d_order_id` text;
--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `failure_reason` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `ordersTable_stripe_event_id_unique` ON `ordersTable` (`stripe_event_id`);
