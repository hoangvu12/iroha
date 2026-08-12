CREATE TABLE "upstream_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD COLUMN "allowed_models" jsonb;--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD COLUMN "denied_models" jsonb;--> statement-breakpoint
ALTER TABLE "upstream_accounts" ADD CONSTRAINT "upstream_accounts_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD CONSTRAINT "upstream_keys_account_id_upstream_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."upstream_accounts"("id") ON DELETE set null ON UPDATE no action;