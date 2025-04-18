CREATE TABLE `authenticators` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`credential_id` text NOT NULL,
	`credential_public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authenticators_user_credential_unique` ON `authenticators` (`user_id`,`credential_id`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
