CREATE TABLE "provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	"allow_insecure_http" boolean NOT NULL,
	"enabled" boolean NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstream_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"encrypted_key" text NOT NULL,
	"health" text NOT NULL,
	"last_probe_at" timestamp with time zone,
	"last_probe_verdict" text,
	"last_probe_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD CONSTRAINT "upstream_keys_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;