CREATE TABLE `leads` (
	`id` integer PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`status` text,
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
