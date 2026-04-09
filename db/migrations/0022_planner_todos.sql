-- Migration: 0022_planner_todos
-- Open to-do list for the weekly planner (unscheduled tasks)

CREATE TABLE IF NOT EXISTS planner_todos (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) NOT NULL,
  text       TEXT NOT NULL,
  done       BOOLEAN NOT NULL DEFAULT false,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_planner_todos_user ON planner_todos(user_id, position);
