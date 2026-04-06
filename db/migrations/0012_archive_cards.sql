-- Allow manually archiving full cards from study correction flow.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS archived_reason TEXT;

CREATE INDEX IF NOT EXISTS cards_archived_at_idx ON cards(archived_at);
