ALTER TABLE "upstream_keys" ADD COLUMN "health_reason" text;--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD COLUMN "health_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD COLUMN "retry_after_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD COLUMN "health_scope" text DEFAULT 'key' NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD COLUMN "health_scope_id" text;--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD COLUMN "health_model" text;