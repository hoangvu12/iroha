-- The model an Attempt's answer said served it (a dated snapshot, the model a
-- router chose), read from the upstream answer; '' when it named none or the
-- Attempt failed. Callers still see the model they asked for.
ALTER TABLE attempts ADD COLUMN reported_model TEXT NOT NULL DEFAULT '';
