ALTER TABLE `cart` ADD `user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `cart` ADD `filament_id` text DEFAULT '76fe1f79-3f1e-43e4-b8f4-61159de5b93c';