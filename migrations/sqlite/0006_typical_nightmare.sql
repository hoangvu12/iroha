ALTER TABLE `upstream_keys` ADD `health_reason` text;--> statement-breakpoint
ALTER TABLE `upstream_keys` ADD `health_changed_at` integer;--> statement-breakpoint
ALTER TABLE `upstream_keys` ADD `retry_after_at` integer;--> statement-breakpoint
ALTER TABLE `upstream_keys` ADD `health_scope` text DEFAULT 'key' NOT NULL;--> statement-breakpoint
ALTER TABLE `upstream_keys` ADD `health_scope_id` text;--> statement-breakpoint
ALTER TABLE `upstream_keys` ADD `health_model` text;