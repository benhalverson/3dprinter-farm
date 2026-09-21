CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE TABLE `visit` (
	`id` text PRIMARY KEY NOT NULL,
	`capability` text NOT NULL,
	`created` integer NOT NULL,
	`touched` integer NOT NULL,
	`visitor` text NOT NULL
);
