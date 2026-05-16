CREATE TABLE `guild_settings` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`panel_channel_id` text NOT NULL,
	`panel_message_id` text,
	`socials_channel_id` text NOT NULL,
	`trigger_role_id` text,
	`log_channel_id` text,
	`format` text DEFAULT 'inline' NOT NULL,
	`template` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monitors` (
	`guild_id` text NOT NULL,
	`type` text NOT NULL,
	`handle` text NOT NULL,
	`ig_id` text,
	`last_fetched_at` integer,
	`last_fetched_by` text,
	`profile_name` text,
	PRIMARY KEY(`guild_id`, `type`, `handle`),
	FOREIGN KEY (`guild_id`) REFERENCES `guild_settings`(`guild_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pending_reviews` (
	`review_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`post_id` text NOT NULL,
	`message_ids` text DEFAULT '[]' NOT NULL,
	`file_names` text DEFAULT '[]' NOT NULL,
	`removed_indices` text DEFAULT '[]' NOT NULL,
	`custom_content` text,
	`rendered_content` text NOT NULL,
	`socials_channel_id` text NOT NULL,
	`format` text NOT NULL,
	`template` text NOT NULL,
	`fetcher_user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`guild_id` text NOT NULL,
	`type` text NOT NULL,
	`handle` text NOT NULL,
	`post_id` text NOT NULL,
	`seen_at` integer NOT NULL,
	`posted_message_id` text,
	PRIMARY KEY(`guild_id`, `type`, `handle`, `post_id`),
	FOREIGN KEY (`guild_id`,`type`,`handle`) REFERENCES `monitors`(`guild_id`,`type`,`handle`) ON UPDATE no action ON DELETE cascade
);
