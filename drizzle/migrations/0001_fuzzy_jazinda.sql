ALTER TABLE `pending_reviews` ADD `post_url` text NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_reviews` ADD `platform` text NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_reviews` ADD `username` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_reviews` ADD `original_text` text DEFAULT '' NOT NULL;