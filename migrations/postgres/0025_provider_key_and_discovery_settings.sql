ALTER TABLE "providers" ADD COLUMN "requires_upstream_key" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "model_discovery" text;