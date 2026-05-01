-- Migration: 0062_close_orphaned_study_sessions
-- Retroactively close sessions that were never completed (actual_minutes IS NULL,
-- ended_at IS NULL) due to the client-side race condition fixed in main.js.
--
-- Strategy (in priority order):
--   1. If a later session from the same user started within 24 h → use that as ended_at
--   2. Otherwise if activity_log has entries after the session started → use the last one
--   3. Otherwise default to started_at + 30 minutes as a conservative estimate

WITH next_session AS (
  SELECT DISTINCT ON (orphan.id)
    orphan.id AS orphan_id,
    nxt.started_at AS next_started_at
  FROM study_sessions orphan
  JOIN study_sessions nxt
    ON nxt.user_id     = orphan.user_id
   AND nxt.started_at  > orphan.started_at
   AND nxt.started_at <= orphan.started_at + INTERVAL '24 hours'
  WHERE orphan.actual_minutes IS NULL
    AND orphan.ended_at IS NULL
  ORDER BY orphan.id, nxt.started_at ASC
),
last_activity AS (
  SELECT DISTINCT ON (s.id)
    s.id AS orphan_id,
    MAX(al.created_at) AS last_at
  FROM study_sessions s
  JOIN activity_log al
    ON al.user_id    = s.user_id
   AND al.created_at > s.started_at
   AND al.created_at <= s.started_at + INTERVAL '24 hours'
  WHERE s.actual_minutes IS NULL
    AND s.ended_at IS NULL
  GROUP BY s.id
),
resolved AS (
  SELECT
    s.id,
    COALESCE(
      ns.next_started_at,
      la.last_at,
      s.started_at + INTERVAL '30 minutes'
    ) AS resolved_end
  FROM study_sessions s
  LEFT JOIN next_session ns ON ns.orphan_id = s.id
  LEFT JOIN last_activity la ON la.orphan_id = s.id
  WHERE s.actual_minutes IS NULL
    AND s.ended_at IS NULL
)
UPDATE study_sessions ss
SET
  ended_at       = r.resolved_end,
  actual_minutes = GREATEST(0, EXTRACT(EPOCH FROM (r.resolved_end - ss.started_at)) / 60.0)
FROM resolved r
WHERE ss.id = r.id;
