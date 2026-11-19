-- Gateway Key capture switch: 1 stores the full prompt and response of every
-- Request made with the key (table captures); 0 stores neither.
ALTER TABLE gateway_keys ADD COLUMN capture INTEGER NOT NULL DEFAULT 0;
