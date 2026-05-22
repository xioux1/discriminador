-- Add 'actividad_fisica' as a valid activity type.
-- The original CHECK constraint is dropped without replacement because
-- manual_activity_sessions also stores custom type slugs, which a fixed
-- enum constraint would reject. Type validation lives in the application layer.
DO $$
DECLARE
  cname TEXT;
BEGIN
  FOR cname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'manual_activity_sessions'::regclass
      AND contype = 'c'
      AND conname LIKE '%activity_type%'
  LOOP
    EXECUTE 'ALTER TABLE manual_activity_sessions DROP CONSTRAINT ' || quote_ident(cname);
  END LOOP;
END;
$$;
