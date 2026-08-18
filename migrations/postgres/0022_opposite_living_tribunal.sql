CREATE TABLE "key_model_availability" (
	"key_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"models" jsonb NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	"stale" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "key_model_availability" ADD CONSTRAINT "key_model_availability_key_id_upstream_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."upstream_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_model_availability" ADD CONSTRAINT "key_model_availability_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;