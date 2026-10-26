CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "background_jobs_status_idx" ON "background_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "key_model_availability_provider_id_idx" ON "key_model_availability" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "owner_sessions_expires_at_idx" ON "owner_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "request_attempts_request_id_idx" ON "request_attempts" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "request_events_occurred_at_idx" ON "request_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "request_events_lifecycle_occurred_at_idx" ON "request_events" USING btree ("lifecycle","occurred_at");--> statement-breakpoint
CREATE INDEX "request_events_provider_id_occurred_at_idx" ON "request_events" USING btree ("provider_id","occurred_at");--> statement-breakpoint
CREATE INDEX "upstream_accounts_provider_id_idx" ON "upstream_accounts" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "upstream_keys_provider_id_idx" ON "upstream_keys" USING btree ("provider_id");