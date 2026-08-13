CREATE TEMP TABLE _pc_to_pr AS
SELECT id AS old_id, 'pr_' || substr(id, 4) AS new_id
FROM provider_connections
WHERE id LIKE 'pc_%';--> statement-breakpoint
CREATE TEMP TABLE _scope_guard (allowed integer NOT NULL DEFAULT 0 CHECK (allowed = 0));--> statement-breakpoint
INSERT INTO _scope_guard (allowed)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM gateway_keys, json_each(gateway_keys.scope) AS entry
  WHERE json_extract(entry.value, '$.connectionId') LIKE 'pc_%'
    AND json_extract(entry.value, '$.connectionId') NOT IN (SELECT old_id FROM _pc_to_pr)
) THEN 1 ELSE 0 END;--> statement-breakpoint
WITH RECURSIVE walk(key_id, scope, idx, total, result) AS (
  SELECT id, scope, 0, json_array_length(scope), '[]'
  FROM gateway_keys
  WHERE json_array_length(scope) > 0
  UNION ALL
  SELECT
    w.key_id,
    w.scope,
    w.idx + 1,
    w.total,
    json_insert(
      w.result,
      '$[#]',
      json_set(
        json_remove(
          json_extract(w.scope, '$[' || w.idx || ']'),
          '$.connectionId'
        ),
        '$.providerId',
        CASE
          WHEN json_extract(json_extract(w.scope, '$[' || w.idx || ']'), '$.connectionId') IN (SELECT old_id FROM _pc_to_pr)
          THEN (SELECT new_id FROM _pc_to_pr WHERE old_id = json_extract(json_extract(w.scope, '$[' || w.idx || ']'), '$.connectionId'))
          ELSE json_extract(json_extract(w.scope, '$[' || w.idx || ']'), '$.connectionId')
        END
      )
    )
  FROM walk w
  WHERE w.idx < w.total
)
UPDATE gateway_keys
SET scope = (SELECT result FROM walk WHERE walk.key_id = gateway_keys.id AND walk.idx = walk.total)
WHERE id IN (SELECT DISTINCT key_id FROM walk);--> statement-breakpoint
DROP TABLE _pc_to_pr;--> statement-breakpoint
DROP TABLE _scope_guard;--> statement-breakpoint
ALTER TABLE `provider_connections` RENAME TO `providers`;--> statement-breakpoint
ALTER TABLE `upstream_keys` RENAME COLUMN `connection_id` TO `provider_id`;--> statement-breakpoint
ALTER TABLE `upstream_accounts` RENAME COLUMN `connection_id` TO `provider_id`;--> statement-breakpoint
ALTER TABLE `model_catalog_entries` RENAME COLUMN `connection_id` TO `provider_id`;--> statement-breakpoint
ALTER TABLE `model_catalog_sync` RENAME COLUMN `connection_id` TO `provider_id`;--> statement-breakpoint
ALTER TABLE `request_events` RENAME COLUMN `connection_id` TO `provider_id`;--> statement-breakpoint
ALTER TABLE `usage_snapshots` RENAME COLUMN `connection_id` TO `provider_id`;--> statement-breakpoint
ALTER TABLE `upstream_keys` ADD `base_url` text;
