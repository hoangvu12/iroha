ALTER TABLE "providers" ADD COLUMN "handle" text;
--> statement-breakpoint
DO $$ DECLARE item record; base text; candidate text; suffix integer; BEGIN
FOR item IN SELECT id, display_name FROM providers ORDER BY created_at, id LOOP
  base := left(COALESCE(NULLIF(trim(both '-' from regexp_replace(
      regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
        lower(item.display_name), '[àáâãäåāăąạảấầẩẫậắằẳẵặ]', 'a', 'g'),
        '[èéêëēėęẹẻẽếềểễệ]', 'e', 'g'), '[ìíîïīįịỉĩ]', 'i', 'g'),
        '[òóôõöøōőọỏốồổỗộớờởỡợ]', 'o', 'g'), '[ùúûüūűųụủũứừửữự]', 'u', 'g'),
        '[ýÿỳỵỷỹ]', 'y', 'g'), 'đ', 'd', 'g'), '[^a-z0-9]+', '-', 'g')), ''), 'provider'), 63)
  ;
  candidate := base; suffix := 2;
  WHILE EXISTS (SELECT 1 FROM providers WHERE handle = candidate) LOOP
    candidate := rtrim(left(base, 63 - length('-' || suffix)), '-') || '-' || suffix;
    suffix := suffix + 1;
  END LOOP;
  UPDATE providers SET handle = candidate WHERE id = item.id;
END LOOP; END $$;
--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "handle" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_handle_unique" UNIQUE("handle");
--> statement-breakpoint
CREATE FUNCTION reject_provider_handle_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.handle IS DISTINCT FROM OLD.handle THEN RAISE EXCEPTION 'providers.handle is immutable'; END IF; RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER providers_handle_immutable_update BEFORE UPDATE OF handle ON providers FOR EACH ROW EXECUTE FUNCTION reject_provider_handle_update();
