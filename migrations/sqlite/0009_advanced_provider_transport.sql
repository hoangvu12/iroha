ALTER TABLE `provider_connections` ADD `auth_header` text DEFAULT 'authorization' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `auth_prefix` text DEFAULT 'Bearer ' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `static_headers_encrypted` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `redirect_allow_same_origin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `connection_timeout_ms` integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `first_byte_timeout_ms` integer DEFAULT 20000 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `non_streaming_total_timeout_ms` integer DEFAULT 120000 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `streaming_idle_timeout_ms` integer DEFAULT 30000 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `total_retry_timeout_ms` integer DEFAULT 30000 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `idempotency_header` text DEFAULT 'Idempotency-Key' NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_keys` ADD `cors_origins` text DEFAULT '[]' NOT NULL;
