ALTER TABLE "request_events" ADD COLUMN "gateway_key_name" text;--> statement-breakpoint
UPDATE "request_events"
SET "gateway_key_name" = "gateway_keys"."name"
FROM "gateway_keys"
WHERE "request_events"."gateway_key_id" = "gateway_keys"."id";
