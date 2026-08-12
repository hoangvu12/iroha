CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `owner` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`password_changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owner_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text
);
