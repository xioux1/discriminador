-- 0094 failed because rows with custom activity type slugs violate the rebuilt
-- CHECK constraint. The application validates types at the route level (built-in
-- list + custom_activity_types table), so no DB-level CHECK is needed.
-- Drop whichever constraint exists, add nothing back.
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
