-- Esquema base para persistencia del flujo de evaluación humana + discriminador.

CREATE TABLE IF NOT EXISTS evaluation_sessions (
    id BIGSERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    subject VARCHAR(100),
    deck_filter VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evaluation_items (
    id BIGSERIAL PRIMARY KEY,
    source_system VARCHAR(100) NOT NULL,
    source_record_id VARCHAR(255) NOT NULL,
    input_payload JSONB NOT NULL,
    evaluator_context JSONB,
    evaluation_session_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_system, source_record_id),
    CONSTRAINT fk_evaluation_items_session
        FOREIGN KEY (evaluation_session_id)
        REFERENCES evaluation_sessions (id)
        ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS grade_suggestions (
    id BIGSERIAL PRIMARY KEY,
    evaluation_item_id BIGINT NOT NULL,
    suggested_grade VARCHAR(50) NOT NULL,
    confidence NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    model_name VARCHAR(100),
    model_version VARCHAR(50),
    explanation TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_grade_suggestions_evaluation_item
        FOREIGN KEY (evaluation_item_id)
        REFERENCES evaluation_items (id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_decisions (
    id BIGSERIAL PRIMARY KEY,
    evaluation_item_id BIGINT NOT NULL,
    final_grade VARCHAR(50) NOT NULL,
    decision_type VARCHAR(20) NOT NULL CHECK (decision_type IN ('accepted', 'corrected', 'uncertain')),
    reason TEXT,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_user_decisions_evaluation_item
        FOREIGN KEY (evaluation_item_id)
        REFERENCES evaluation_items (id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_evaluation_items_session_id
    ON evaluation_items (evaluation_session_id);

CREATE INDEX IF NOT EXISTS idx_grade_suggestions_evaluation_item_id
    ON grade_suggestions (evaluation_item_id);

CREATE INDEX IF NOT EXISTS idx_user_decisions_evaluation_item_id
    ON user_decisions (evaluation_item_id);

CREATE INDEX IF NOT EXISTS idx_user_decisions_decided_at
    ON user_decisions (decided_at);
