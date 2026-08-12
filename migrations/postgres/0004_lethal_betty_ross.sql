CREATE TABLE "model_catalog_entries" (
	"connection_id" text NOT NULL,
	"model_id" text NOT NULL,
	"source" text NOT NULL,
	"excluded" boolean NOT NULL,
	"overrides" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_catalog_entries_connection_id_model_id_pk" PRIMARY KEY("connection_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "model_catalog_sync" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"synced_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure_message" text
);
--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "template_id" text;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "capabilities" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog_entries" ADD CONSTRAINT "model_catalog_entries_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_catalog_sync" ADD CONSTRAINT "model_catalog_sync_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;