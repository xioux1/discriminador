-- Migration: 0008_curriculum
CREATE TABLE IF NOT EXISTS subject_configs (
  id           SERIAL PRIMARY KEY,
  subject      TEXT NOT NULL UNIQUE,
  syllabus_text TEXT,              -- plan de estudios completo (texto libre)
  exam_date    DATE,               -- próximo parcial/final
  exam_type    TEXT DEFAULT 'parcial', -- 'parcial' | 'final'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_exams (
  id           SERIAL PRIMARY KEY,
  subject      TEXT NOT NULL,
  exam_type    TEXT NOT NULL DEFAULT 'parcial',
  year         INT,
  label        TEXT,               -- ej: "2do Parcial 2023"
  content_text TEXT NOT NULL,      -- preguntas/consignas del examen
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reference_exams_subject_idx ON reference_exams(subject);
