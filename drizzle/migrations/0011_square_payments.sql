ALTER TABLE `products` DROP COLUMN `stripe_product_id`;--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `stripe_price_id`;--> statement-breakpoint
ALTER TABLE `ordersTable` DROP COLUMN `stripe_checkout_session_id`;--> statement-breakpoint
ALTER TABLE `ordersTable` DROP COLUMN `stripe_payment_intent_id`;--> statement-breakpoint
ALTER TABLE `ordersTable` DROP COLUMN `stripe_event_id`;--> statement-breakpoint
ALTER TABLE `order_cancellation_attempts` DROP COLUMN `stripe_refund_id`;--> statement-breakpoint
ALTER TABLE `order_cancellation_attempts` DROP COLUMN `stripe_refund_status`;--> statement-breakpoint
ALTER TABLE `order_cancellation_attempts` DROP COLUMN `stripe_result`;--> statement-breakpoint
DROP TABLE IF EXISTS `stripe_fulfillment`;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `payment_provider` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `payment_provider_order_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `payment_provider_payment_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `payment_provider_event_id` text;--> statement-breakpoint
ALTER TABLE `ordersTable` ADD `payment_status` text;--> statement-breakpoint
ALTER TABLE `order_cancellation_attempts` ADD `payment_refund_id` text;--> statement-breakpoint
ALTER TABLE `order_cancellation_attempts` ADD `payment_refund_status` text;--> statement-breakpoint
ALTER TABLE `order_cancellation_attempts` ADD `payment_refund_result` text;--> statement-breakpoint
CREATE TABLE `payment_fulfillment` (
  `idempotency_key` text PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `provider_payment_id` text NOT NULL,
  `provider_order_id` text,
  `cart_id` text NOT NULL,
  `user_id` text NOT NULL,
  `status` text DEFAULT 'paid' NOT NULL,
  `slant_order_id` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
