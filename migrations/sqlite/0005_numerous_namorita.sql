CREATE TABLE `upstream_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `upstream_keys` ADD `account_id` text REFERENCES upstream_accounts(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `upstream_keys` ADD `allowed_models` text;--> statement-breakpoint
ALTER TABLE `upstream_keys` ADD `denied_models` text;