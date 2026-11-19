-- Model metadata (ticket 11). A Provider's models.dev brand is the
-- models.dev provider ID its models are looked up under ('' = none: only the
-- maker catalog, by model name).
ALTER TABLE providers ADD COLUMN models_dev_brand TEXT NOT NULL DEFAULT '';

-- Per entry: the Owner's overrides (JSON, audited with the entry; '' = none;
-- an entry with overrides is kept like an added or hidden one), and the
-- facts models.dev gave at the last lookup (JSON, runtime state) with the
-- brand they were looked up under: facts of another brand are not used.
ALTER TABLE provider_models ADD COLUMN overrides TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_models ADD COLUMN external TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_models ADD COLUMN external_brand TEXT NOT NULL DEFAULT '';
