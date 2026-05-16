ALTER TABLE `pending_reviews` ADD `status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_reviews` ADD `posted_discord_url` text;