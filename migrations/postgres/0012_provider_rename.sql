-- Renames Provider Connection to Provider and adds per-Upstream-Key base URL.
--
-- Step 1: every gateway_keys.scope entry whose connectionId still starts with
-- `pc_` rewrites to `pr_<suffix>` and renames the JSON key from `connectionId`
-- to `providerId`. The underlying ID value (the base64url payload after the
-- prefix) is preserved; only the prefix changes. A scope that references a
-- `pc_*` Provider that does not exist aborts the migration.
--
-- Step 2: rename the table `provider_connections` to `providers`, the foreign
-- key columns `connection_id` on `upstream_keys`, `upstream_accounts`,
-- `model_catalog_entries`, `model_catalog_sync`, `request_events`, and
-- `usage_snapshots` to `provider_id`, and rebuild the foreign-key constraints
-- so they point at the renamed table.
--
-- Step 3: add a nullable `upstream_keys.base_url` column for the per-key base
-- URL override.
--> statement-breakpoint
DO $$
DECLARE
  unmapped_count integer;
BEGIN
  UPDATE gateway_keys gw
  SET scope = (
    SELECT jsonb_agg(
      CASE
        WHEN entry ? 'connectionId'
          AND entry->>'connectionId' LIKE 'pc_%'
          AND EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.id = entry->>'connectionId')
        THEN jsonb_set(entry - 'connectionId', '{providerId}', to_jsonb('pr_' || substring(entry->>'connectionId' FROM 4)))
        WHEN entry ? 'connectionId'
          AND entry->>'connectionId' LIKE 'pc_%'
        THEN jsonb_set(entry - 'connectionId', '{providerId}', to_jsonb('__UNRESOLVED__'))
        ELSE entry
      END
    )
    FROM jsonb_array_elements(gw.scope) AS entry
  )
  WHERE jsonb_array_length(gw.scope) > 0;

  SELECT COUNT(*) INTO unmapped_count
  FROM gateway_keys, jsonb_array_elements(scope) AS entry
  WHERE entry->>'providerId' = '__UNRESOLVED__';

  IF unmapped_count > 0 THEN
    RAISE EXCEPTION 'gateway_keys.scope references a Provider Connection that does not exist; the migration cannot proceed safely';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "provider_connections" RENAME TO "providers";--> statement-breakpoint
ALTER TABLE "upstream_keys" RENAME COLUMN "connection_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "upstream_accounts" RENAME COLUMN "connection_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "model_catalog_entries" RENAME COLUMN "connection_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "model_catalog_sync" RENAME COLUMN "connection_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "request_events" RENAME COLUMN "connection_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "usage_snapshots" RENAME COLUMN "connection_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "model_catalog_entries" DROP CONSTRAINT "model_catalog_entries_connection_id_provider_connections_id_fk";--> statement-breakpoint
ALTER TABLE "model_catalog_entries" ADD CONSTRAINT "model_catalog_entries_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_catalog_sync" DROP CONSTRAINT "model_catalog_sync_connection_id_provider_connections_id_fk";--> statement-breakpoint
ALTER TABLE "model_catalog_sync" ADD CONSTRAINT "model_catalog_sync_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" DROP CONSTRAINT "request_events_connection_id_provider_connections_id_fk";--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_accounts" DROP CONSTRAINT "upstream_accounts_connection_id_provider_connections_id_fk";--> statement-breakpoint
ALTER TABLE "upstream_accounts" ADD CONSTRAINT "upstream_accounts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_keys" DROP CONSTRAINT "upstream_keys_connection_id_provider_connections_id_fk";--> statement-breakpoint
ALTER TABLE "upstream_keys" ADD CONSTRAINT "upstream_keys_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_snapshots" DROP CONSTRAINT "usage_snapshots_connection_id_provider_connections_id_fk";--> statement-breakpoint
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;
