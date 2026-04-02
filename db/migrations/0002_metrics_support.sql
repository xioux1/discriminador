-- Métricas MVP0: soporte para duda y sesión temporal.

BEGIN;

-- Permite marcar casos como duda en la firma humana.
ALTER TABLE user_decisions
    DROP CONSTRAINT IF EXISTS user_decisions_decision_type_check;

ALTER TABLE user_decisions
    ADD CONSTRAINT user_decisions_decision_type_check
    CHECK (decision_type IN ('accepted', 'corrected', 'uncertain'));

-- Relaciona ítems con una sesión explícita para medir tiempos desde inicio.
CREATE TABLE IF NOT EXISTS evaluation_sessions (
    id BIGSERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    subject VARCHAR(100),
    deck_filter VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE evaluation_items
    ADD COLUMN IF NOT EXISTS evaluation_session_id BIGINT,
    ADD CONSTRAINT fk_evaluation_items_session
        FOREIGN KEY (evaluation_session_id)
        REFERENCES evaluation_sessions (id)
        ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_evaluation_items_session_id
    ON evaluation_items (evaluation_session_id);

CREATE INDEX IF NOT EXISTS idx_user_decisions_decided_at
    ON user_decisions (decided_at);

COMMIT;
