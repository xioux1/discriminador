-- Annual planification: goals per month, with expandable subtasks
CREATE TABLE IF NOT EXISTS planner_annual_goals (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  month       INTEGER NOT NULL CHECK (month >= 0 AND month <= 11),
  title       TEXT NOT NULL,
  description TEXT,
  color       TEXT NOT NULL DEFAULT '#c9daf8',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_annual_goals_user_year
  ON planner_annual_goals(user_id, year);

CREATE TABLE IF NOT EXISTS planner_annual_goal_tasks (
  id       SERIAL PRIMARY KEY,
  goal_id  INTEGER REFERENCES planner_annual_goals(id) ON DELETE CASCADE,
  user_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  done     BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_annual_goal_tasks_goal
  ON planner_annual_goal_tasks(goal_id);
