CREATE TABLE `model_catalog_entries` (
	`connection_id` text NOT NULL,
	`model_id` text NOT NULL,
	`source` text NOT NULL,
	`excluded` integer NOT NULL,
	`overrides` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `model_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `model_catalog_sync` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`synced_at` integer,
	`last_success_at` integer,
	`last_failure_at` integer,
	`last_failure_message` text,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `template_id` text;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `capabilities` text NOT NULL;