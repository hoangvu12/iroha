CREATE TABLE `usage_snapshots` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`visibility` text NOT NULL,
	`synced_at` integer,
	`last_success_at` integer,
	`last_failure_at` integer,
	`last_failure_code` text,
	`last_failure_message` text,
	`result` text,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
