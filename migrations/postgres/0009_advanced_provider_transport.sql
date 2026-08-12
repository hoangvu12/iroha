ALTER TABLE "provider_connections" ADD COLUMN "auth_header" text DEFAULT 'authorization' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "auth_prefix" text DEFAULT 'Bearer ' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "static_headers_encrypted" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "redirect_allow_same_origin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "connection_timeout_ms" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "first_byte_timeout_ms" integer DEFAULT 20000 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "non_streaming_total_timeout_ms" integer DEFAULT 120000 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "streaming_idle_timeout_ms" integer DEFAULT 30000 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "total_retry_timeout_ms" integer DEFAULT 30000 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "idempotency_header" text DEFAULT 'Idempotency-Key' NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_keys" ADD COLUMN "cors_origins" jsonb DEFAULT '[]'::jsonb NOT NULL;
