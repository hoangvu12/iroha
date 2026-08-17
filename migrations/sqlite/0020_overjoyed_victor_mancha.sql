ALTER TABLE `providers` ADD `logo_domain` text;
--> statement-breakpoint
WITH base_hosts AS (
  SELECT id,
    lower(rtrim(
      CASE
        WHEN instr(authority, '@') > 0 OR substr(authority, 1, 1) = '[' THEN NULL
        WHEN instr(authority, ':') > 0 THEN substr(authority, 1, instr(authority, ':') - 1)
        ELSE authority
      END,
      '.'
    )) AS hostname
  FROM (
    SELECT id,
      substr(without_query, 1, instr(without_query || '#', '#') - 1) AS authority
    FROM (
      SELECT id,
        substr(without_path, 1, instr(without_path || '?', '?') - 1) AS without_query
      FROM (
        SELECT id,
          substr(rest, 1, instr(rest || '/', '/') - 1) AS without_path
        FROM (
          SELECT id, substr(base_url, instr(base_url, '://') + 3) AS rest
          FROM providers
          WHERE lower(base_url) LIKE 'http://%' OR lower(base_url) LIKE 'https://%'
        )
      )
    )
  )
), valid_base_hosts AS (
  SELECT id,
    CASE
      WHEN hostname LIKE '%.%'
        AND hostname NOT GLOB '*[^a-z0-9.-]*'
        AND hostname NOT LIKE '.%'
        AND hostname NOT LIKE '%..%'
      THEN hostname
      ELSE NULL
    END AS hostname
  FROM base_hosts
)
UPDATE providers
SET logo_domain = CASE template_id
  WHEN 'openai' THEN 'openai.com'
  WHEN 'openrouter' THEN 'openrouter.ai'
  WHEN 'dashscope' THEN 'aliyun.com'
  WHEN 'MiniMax' THEN 'minimax.io'
  WHEN 'anthropic' THEN 'anthropic.com'
  WHEN 'zai' THEN 'z.ai'
  ELSE (SELECT hostname FROM valid_base_hosts WHERE valid_base_hosts.id = providers.id)
END;
