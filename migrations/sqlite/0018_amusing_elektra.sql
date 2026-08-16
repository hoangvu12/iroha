ALTER TABLE `providers` ADD `handle` text;
--> statement-breakpoint
WITH RECURSIVE chars(id, created_at, value, position, size) AS (
  SELECT id, created_at, lower(display_name), 1, length(display_name) FROM providers
  UNION ALL SELECT id, created_at, value, position + 1, size FROM chars WHERE position < size
), raw AS (
  SELECT id, created_at, group_concat(
    CASE
      WHEN substr(value, position, 1) GLOB '[a-z0-9]' THEN substr(value, position, 1)
      WHEN instr('àáâãäåāăąạảấầẩẫậắằẳẵặÀÁÂÃÄÅĀĂĄẠẢẤẦẨẪẬẮẰẲẴẶ', substr(value, position, 1)) > 0 THEN 'a'
      WHEN instr('èéêëēėęẹẻẽếềểễệÈÉÊËĒĖĘẸẺẼẾỀỂỄỆ', substr(value, position, 1)) > 0 THEN 'e'
      WHEN instr('ìíîïīįịỉĩÌÍÎÏĪĮỊỈĨ', substr(value, position, 1)) > 0 THEN 'i'
      WHEN instr('òóôõöøōőọỏốồổỗộớờởỡợÒÓÔÕÖØŌŐỌỎỐỒỔỖỘỚỜỞỠỢ', substr(value, position, 1)) > 0 THEN 'o'
      WHEN instr('ùúûüūűųụủũứừửữựÙÚÛÜŪŰŲỤỦŨỨỪỬỮỰ', substr(value, position, 1)) > 0 THEN 'u'
      WHEN instr('ýÿỳỵỷỹÝŸỲỴỶỸ', substr(value, position, 1)) > 0 THEN 'y'
      WHEN instr('đĐ', substr(value, position, 1)) > 0 THEN 'd'
      ELSE '-'
    END, '') AS base
  FROM chars GROUP BY id, created_at
), collapsed(id, created_at, base) AS (
  SELECT id, created_at, trim(base, '-') FROM raw
  UNION ALL SELECT id, created_at, replace(base, '--', '-') FROM collapsed WHERE instr(base, '--') > 0
), final AS (
  SELECT id, created_at, substr(CASE WHEN base = '' THEN 'provider' ELSE base END, 1, 63) AS base FROM collapsed WHERE instr(base, '--') = 0
), ordered AS (
  SELECT id, base, ROW_NUMBER() OVER (ORDER BY created_at, id) AS position FROM final
), allocated(next_position, attempt, used, assigned_id, assigned_handle) AS (
  SELECT 1, 1, json_array(), NULL, NULL
  UNION ALL
  SELECT
    CASE WHEN EXISTS (SELECT 1 FROM json_each(allocated.used) WHERE value = CASE WHEN allocated.attempt = 1 THEN ordered.base ELSE rtrim(substr(ordered.base, 1, 63 - length('-' || allocated.attempt)), '-') || '-' || allocated.attempt END) THEN allocated.next_position ELSE allocated.next_position + 1 END,
    CASE WHEN EXISTS (SELECT 1 FROM json_each(allocated.used) WHERE value = CASE WHEN allocated.attempt = 1 THEN ordered.base ELSE rtrim(substr(ordered.base, 1, 63 - length('-' || allocated.attempt)), '-') || '-' || allocated.attempt END) THEN allocated.attempt + 1 ELSE 1 END,
    CASE WHEN EXISTS (SELECT 1 FROM json_each(allocated.used) WHERE value = CASE WHEN allocated.attempt = 1 THEN ordered.base ELSE rtrim(substr(ordered.base, 1, 63 - length('-' || allocated.attempt)), '-') || '-' || allocated.attempt END) THEN allocated.used ELSE json_insert(allocated.used, '$[#]', CASE WHEN allocated.attempt = 1 THEN ordered.base ELSE rtrim(substr(ordered.base, 1, 63 - length('-' || allocated.attempt)), '-') || '-' || allocated.attempt END) END,
    CASE WHEN EXISTS (SELECT 1 FROM json_each(allocated.used) WHERE value = CASE WHEN allocated.attempt = 1 THEN ordered.base ELSE rtrim(substr(ordered.base, 1, 63 - length('-' || allocated.attempt)), '-') || '-' || allocated.attempt END) THEN NULL ELSE ordered.id END,
    CASE WHEN EXISTS (SELECT 1 FROM json_each(allocated.used) WHERE value = CASE WHEN allocated.attempt = 1 THEN ordered.base ELSE rtrim(substr(ordered.base, 1, 63 - length('-' || allocated.attempt)), '-') || '-' || allocated.attempt END) THEN NULL ELSE CASE WHEN allocated.attempt = 1 THEN ordered.base ELSE rtrim(substr(ordered.base, 1, 63 - length('-' || allocated.attempt)), '-') || '-' || allocated.attempt END END
  FROM allocated JOIN ordered ON ordered.position = allocated.next_position
)
UPDATE providers SET handle = (
  SELECT assigned_handle FROM allocated WHERE assigned_id = providers.id
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_handle_unique` ON `providers` (`handle`);
--> statement-breakpoint
CREATE TRIGGER `providers_handle_required_insert` BEFORE INSERT ON `providers`
WHEN NEW.handle IS NULL BEGIN SELECT RAISE(ABORT, 'providers.handle is required'); END;
--> statement-breakpoint
CREATE TRIGGER `providers_handle_immutable_update` BEFORE UPDATE OF `handle` ON `providers`
WHEN NEW.handle IS NOT OLD.handle BEGIN SELECT RAISE(ABORT, 'providers.handle is immutable'); END;
