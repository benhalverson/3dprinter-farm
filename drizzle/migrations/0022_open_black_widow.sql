ALTER TABLE `order_cancellation_attempts` DROP COLUMN `stripe_refund_id`;--> statement-breakpoint
ALTER TABLE `order_cancellation_attempts` DROP COLUMN `stripe_refund_status`;--> statement-breakpoint
ALTER TABLE `order_cancellation_attempts` DROP COLUMN `stripe_result`;--> statement-breakpoint
ALTER TABLE `ordersTable` DROP COLUMN `stripe_checkout_session_id`;--> statement-breakpoint
ALTER TABLE `ordersTable` DROP COLUMN `stripe_payment_intent_id`;--> statement-breakpoint
ALTER TABLE `ordersTable` DROP COLUMN `stripe_event_id`;--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `stripe_price_id`;