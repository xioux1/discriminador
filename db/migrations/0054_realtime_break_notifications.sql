ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS realtime_break_notifications_enabled BOOLEAN NOT NULL DEFAULT true;
