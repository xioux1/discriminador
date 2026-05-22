-- Add 'actividad_fisica' to the allowed activity types in manual_activity_sessions.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'manual_activity_sessions'::regclass
    AND contype = 'c'
    AND conname LIKE '%activity_type%';
  IF cname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE manual_activity_sessions DROP CONSTRAINT ' || quote_ident(cname);
  END IF;
END;
$$;

ALTER TABLE manual_activity_sessions
  ADD CONSTRAINT manual_activity_sessions_activity_type_check
  CHECK (activity_type IN ('clase', 'contenido', 'estudio_offline', 'reunion', 'otro', 'actividad_fisica'));
