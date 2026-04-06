-- Add suspend/reactivate support for card browser actions.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS cards_suspended_at_idx ON cards(suspended_at);
