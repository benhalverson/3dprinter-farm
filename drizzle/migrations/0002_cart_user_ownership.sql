ALTER TABLE `cart` ADD `user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL;
