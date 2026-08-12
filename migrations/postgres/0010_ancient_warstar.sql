CREATE TABLE "request_attempts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "request_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"request_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"key_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" integer,
	"outcome" text NOT NULL,
	"error_code" text,
	"retry_after_seconds" integer
);
--> statement-breakpoint
CREATE TABLE "request_events" (
	"id" text PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"connection_id" text NOT NULL,
	"model" text NOT NULL,
	"gateway_key_id" text,
	"key_id" text,
	"status" integer NOT NULL,
	"outcome" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"is_streaming" boolean NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"error_code" text
);
--> statement-breakpoint
ALTER TABLE "gateway_keys" ALTER COLUMN "cors_origins" SET DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "request_attempts" ADD CONSTRAINT "request_attempts_request_id_request_events_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;