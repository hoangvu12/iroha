CREATE TABLE "usage_snapshots" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"visibility" text NOT NULL,
	"synced_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure_code" text,
	"last_failure_message" text,
	"result" jsonb
);
--> statement-breakpoint
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;