PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_order_cancellation_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`actor_id` text,
	`actor_email` text,
	`reason` text,
	`override` integer DEFAULT false NOT NULL,
	`slant_status` text,
	`slant_result` text,
	`final_status` text NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_order_cancellation_attempts`("id", "order_id", "actor_id", "actor_email", "reason", "override", "slant_status", "slant_result", "final_status", "error_message", "created_at", "updated_at") SELECT "id", "order_id", "actor_id", "actor_email", "reason", "override", "slant_status", "slant_result", "final_status", "error_message", "created_at", "updated_at" FROM `order_cancellation_attempts`;--> statement-breakpoint
DROP TABLE `order_cancellation_attempts`;--> statement-breakpoint
ALTER TABLE `__new_order_cancellation_attempts` RENAME TO `order_cancellation_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_order_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`type` text NOT NULL,
	`dedupe_key` text,
	`detail` text,
	`actor` text,
	`external_event_id` text,
	`source` text DEFAULT 'admin',
	`previous_status` text,
	`next_status` text,
	`metadata` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_order_events`("id", "order_id", "type", "dedupe_key", "detail", "actor", "external_event_id", "source", "previous_status", "next_status", "metadata", "created_at") SELECT "id", "order_id", "type", "dedupe_key", "detail", "actor", "external_event_id", "source", "previous_status", "next_status", "metadata", "created_at" FROM `order_events`;--> statement-breakpoint
DROP TABLE `order_events`;--> statement-breakpoint
ALTER TABLE `__new_order_events` RENAME TO `order_events`;--> statement-breakpoint
CREATE UNIQUE INDEX `order_events_dedupe_key_unique` ON `order_events` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `__new_order_notification_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`notification_type` text NOT NULL,
	`recipient_email` text NOT NULL,
	`status` text NOT NULL,
	`delivery_key` text,
	`sender_email` text,
	`subject` text,
	`text_content` text,
	`claim_token` text,
	`provider_message_id` text,
	`error_message` text,
	`status_transition` text,
	`source` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
INSERT INTO `__new_order_notification_attempts`("id", "order_id", "notification_type", "recipient_email", "status", "delivery_key", "sender_email", "subject", "text_content", "claim_token", "provider_message_id", "error_message", "status_transition", "source", "idempotency_key", "created_at", "updated_at", "sent_at") SELECT "id", "order_id", "notification_type", "recipient_email", "status", "delivery_key", "sender_email", "subject", "text_content", "claim_token", "provider_message_id", "error_message", "status_transition", "source", "idempotency_key", "created_at", "updated_at", "sent_at" FROM `order_notification_attempts`;--> statement-breakpoint
DROP TABLE `order_notification_attempts`;--> statement-breakpoint
ALTER TABLE `__new_order_notification_attempts` RENAME TO `order_notification_attempts`;--> statement-breakpoint
CREATE UNIQUE INDEX `order_notification_attempts_delivery_key_unique` ON `order_notification_attempts` (`delivery_key`);--> statement-breakpoint
CREATE TABLE `__new_order_reconciliation_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`trigger_source` text NOT NULL,
	`starting_state` text NOT NULL,
	`detected_issue_type` text,
	`actions_taken` text,
	`result_status` text NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_order_reconciliation_attempts`("id", "order_id", "trigger_source", "starting_state", "detected_issue_type", "actions_taken", "result_status", "error_message", "created_at", "updated_at") SELECT "id", "order_id", "trigger_source", "starting_state", "detected_issue_type", "actions_taken", "result_status", "error_message", "created_at", "updated_at" FROM `order_reconciliation_attempts`;--> statement-breakpoint
DROP TABLE `order_reconciliation_attempts`;--> statement-breakpoint
ALTER TABLE `__new_order_reconciliation_attempts` RENAME TO `order_reconciliation_attempts`;