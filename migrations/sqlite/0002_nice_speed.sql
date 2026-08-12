CREATE TABLE `provider_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`base_url` text NOT NULL,
	`allow_insecure_http` integer NOT NULL,
	`enabled` integer NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `upstream_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`health` text NOT NULL,
	`last_probe_at` integer,
	`last_probe_verdict` text,
	`last_probe_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
