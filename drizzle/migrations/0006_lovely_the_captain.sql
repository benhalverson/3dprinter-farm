CREATE TABLE `uploaded_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`public_file_service_id` text NOT NULL,
	`file_name` text NOT NULL,
	`file_url` text NOT NULL,
	`dimension_x` real,
	`dimension_y` real,
	`dimension_z` real,
	`volume` real,
	`weight` real,
	`surface_area` real,
	`default_filament_id` text DEFAULT '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
	`estimated_cost` real,
	`estimated_quantity` integer DEFAULT 1,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploaded_files_public_file_service_id_unique` ON `uploaded_files` (`public_file_service_id`);