-- Card flags: allow reporting duplicates or adding notes from study session
ALTER TABLE cards       ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cards       ADD COLUMN IF NOT EXISTS notes   TEXT;
ALTER TABLE micro_cards ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE micro_cards ADD COLUMN IF NOT EXISTS notes   TEXT;
