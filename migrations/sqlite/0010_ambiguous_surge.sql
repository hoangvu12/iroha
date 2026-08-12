CREATE TABLE `request_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`key_id` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`status` integer,
	`outcome` text NOT NULL,
	`error_code` text,
	`retry_after_seconds` integer,
	FOREIGN KEY (`request_id`) REFERENCES `request_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `request_events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`connection_id` text NOT NULL,
	`model` text NOT NULL,
	`gateway_key_id` text,
	`key_id` text,
	`status` integer NOT NULL,
	`outcome` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`is_streaming` integer NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`error_code` text,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
