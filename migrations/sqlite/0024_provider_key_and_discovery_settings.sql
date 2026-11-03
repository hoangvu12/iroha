ALTER TABLE `providers` ADD `requires_upstream_key` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `model_discovery` text;