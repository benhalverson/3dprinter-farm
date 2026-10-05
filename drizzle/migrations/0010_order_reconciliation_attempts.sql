CREATE TABLE `order_reconciliation_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`trigger_source` text NOT NULL,
	`starting_state` text NOT NULL,
	`detected_issue_type` text,
	`actions_taken` text,
	`result_status` text NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ordersTable`(`id`) ON UPDATE no action ON DELETE cascade
);
