CREATE TABLE `key_model_availability` (
	`key_id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`models` text NOT NULL,
	`discovered_at` integer NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `upstream_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
