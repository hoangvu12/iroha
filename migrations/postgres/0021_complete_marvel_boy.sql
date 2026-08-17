ALTER TABLE "providers" ADD COLUMN "logo_domain" text;
--> statement-breakpoint
UPDATE providers
SET logo_domain = CASE template_id
  WHEN 'openai' THEN 'openai.com'
  WHEN 'openrouter' THEN 'openrouter.ai'
  WHEN 'dashscope' THEN 'alibabacloudmail.com'
  WHEN 'MiniMax' THEN 'minimax.io'
  WHEN 'anthropic' THEN 'anthropic.com'
  WHEN 'zai' THEN 'z.ai'
END
WHERE template_id IN ('openai', 'openrouter', 'dashscope', 'MiniMax', 'anthropic', 'zai');
--> statement-breakpoint
WITH base_hosts AS (
  SELECT id,
    lower(rtrim(
      split_part(
        split_part(
          split_part(regexp_replace(base_url, '^https?://', '', 'i'), '/', 1),
          '?', 1
        ),
        '#', 1
      ),
      '.'
    )) AS authority
  FROM providers
  WHERE base_url ~* '^https?://'
), normalized AS (
  SELECT id,
    CASE
      WHEN authority LIKE '[%' OR authority LIKE '%@%' THEN NULL
      ELSE split_part(authority, ':', 1)
    END AS hostname
  FROM base_hosts
), valid_base_hosts AS (
  SELECT id,
    CASE
      WHEN hostname LIKE '%.%'
        AND hostname ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
        AND hostname NOT LIKE '%..%'
      THEN hostname
      ELSE NULL
    END AS hostname
  FROM normalized
)
UPDATE providers
SET logo_domain = valid_base_hosts.hostname
FROM valid_base_hosts
WHERE valid_base_hosts.id = providers.id
  AND (providers.template_id IS NULL OR providers.template_id NOT IN ('openai', 'openrouter', 'dashscope', 'MiniMax', 'anthropic', 'zai'));
