# Métricas MVP0 (job/report semanal)

Este documento define una implementación simple (SQL + export CSV) para validar el MVP0.

## 1) Acuerdo entre `suggested_grade` y `final_grade`

Definición semanal:

- `agreement_rate = casos_con_suggested_grade_igual_final_grade / casos_firmados`

```sql
WITH latest_suggestion AS (
    SELECT DISTINCT ON (gs.evaluation_item_id)
        gs.evaluation_item_id,
        gs.suggested_grade,
        gs.created_at
    FROM grade_suggestions gs
    ORDER BY gs.evaluation_item_id, gs.created_at DESC
), weekly AS (
    SELECT
        ud.id AS decision_id,
        ud.evaluation_item_id,
        ls.suggested_grade,
        ud.final_grade,
        ud.decision_type,
        ud.decided_at
    FROM user_decisions ud
    JOIN latest_suggestion ls ON ls.evaluation_item_id = ud.evaluation_item_id
    WHERE ud.decided_at >= date_trunc('week', NOW()) - INTERVAL '7 days'
      AND ud.decided_at < date_trunc('week', NOW())
)
SELECT
    COUNT(*) AS signed_cases,
    COUNT(*) FILTER (WHERE suggested_grade = final_grade) AS agreed_cases,
    ROUND(
        COUNT(*) FILTER (WHERE suggested_grade = final_grade)::numeric
        / NULLIF(COUNT(*), 0),
        4
    ) AS agreement_rate
FROM weekly;
```

## 2) Conteo de correcciones manuales y casos con duda

```sql
SELECT
    COUNT(*) FILTER (WHERE decision_type = 'corrected') AS corrected_cases,
    COUNT(*) FILTER (WHERE decision_type = 'uncertain') AS uncertain_cases
FROM user_decisions
WHERE decided_at >= date_trunc('week', NOW()) - INTERVAL '7 days'
  AND decided_at < date_trunc('week', NOW());
```

## 3) Tiempo por evaluación (inicio a firma)

Definición:

- Inicio: `evaluation_sessions.started_at` (si existe sesión)
- Fallback: `evaluation_items.created_at`
- Fin: `user_decisions.decided_at`

```sql
SELECT
    ud.evaluation_item_id,
    EXTRACT(EPOCH FROM (ud.decided_at - COALESCE(es.started_at, ei.created_at))) AS evaluation_seconds
FROM user_decisions ud
JOIN evaluation_items ei ON ei.id = ud.evaluation_item_id
LEFT JOIN evaluation_sessions es ON es.id = ei.evaluation_session_id
WHERE ud.decided_at >= date_trunc('week', NOW()) - INTERVAL '7 days'
  AND ud.decided_at < date_trunc('week', NOW());
```

Agregado semanal recomendado:

```sql
WITH durations AS (
    SELECT
        EXTRACT(EPOCH FROM (ud.decided_at - COALESCE(es.started_at, ei.created_at))) AS evaluation_seconds
    FROM user_decisions ud
    JOIN evaluation_items ei ON ei.id = ud.evaluation_item_id
    LEFT JOIN evaluation_sessions es ON es.id = ei.evaluation_session_id
    WHERE ud.decided_at >= date_trunc('week', NOW()) - INTERVAL '7 days'
      AND ud.decided_at < date_trunc('week', NOW())
)
SELECT
    COUNT(*) AS signed_cases,
    ROUND(AVG(evaluation_seconds), 2) AS avg_seconds,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY evaluation_seconds)::numeric, 2) AS p50_seconds,
    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY evaluation_seconds)::numeric, 2) AS p95_seconds
FROM durations;
```

## 4) Reporte semanal simple (consulta única + CSV)

Consulta única (lista por semana ISO):

```sql
WITH latest_suggestion AS (
    SELECT DISTINCT ON (gs.evaluation_item_id)
        gs.evaluation_item_id,
        gs.suggested_grade,
        gs.created_at
    FROM grade_suggestions gs
    ORDER BY gs.evaluation_item_id, gs.created_at DESC
), base AS (
    SELECT
        date_trunc('week', ud.decided_at)::date AS week_start,
        ud.evaluation_item_id,
        ls.suggested_grade,
        ud.final_grade,
        ud.decision_type,
        EXTRACT(EPOCH FROM (ud.decided_at - COALESCE(es.started_at, ei.created_at))) AS evaluation_seconds
    FROM user_decisions ud
    JOIN evaluation_items ei ON ei.id = ud.evaluation_item_id
    JOIN latest_suggestion ls ON ls.evaluation_item_id = ud.evaluation_item_id
    LEFT JOIN evaluation_sessions es ON es.id = ei.evaluation_session_id
)
SELECT
    week_start,
    COUNT(*) AS signed_cases,
    COUNT(*) FILTER (WHERE suggested_grade = final_grade) AS agreed_cases,
    ROUND(COUNT(*) FILTER (WHERE suggested_grade = final_grade)::numeric / NULLIF(COUNT(*), 0), 4) AS agreement_rate,
    COUNT(*) FILTER (WHERE decision_type = 'corrected') AS corrected_cases,
    COUNT(*) FILTER (WHERE decision_type = 'uncertain') AS uncertain_cases,
    ROUND(AVG(evaluation_seconds), 2) AS avg_seconds,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY evaluation_seconds)::numeric, 2) AS p50_seconds,
    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY evaluation_seconds)::numeric, 2) AS p95_seconds
FROM base
GROUP BY week_start
ORDER BY week_start DESC;
```

Export CSV con `psql`:

```bash
psql "$DATABASE_URL" \
  -c "\copy (
WITH latest_suggestion AS (
    SELECT DISTINCT ON (gs.evaluation_item_id)
        gs.evaluation_item_id,
        gs.suggested_grade,
        gs.created_at
    FROM grade_suggestions gs
    ORDER BY gs.evaluation_item_id, gs.created_at DESC
), base AS (
    SELECT
        date_trunc('week', ud.decided_at)::date AS week_start,
        ud.evaluation_item_id,
        ls.suggested_grade,
        ud.final_grade,
        ud.decision_type,
        EXTRACT(EPOCH FROM (ud.decided_at - COALESCE(es.started_at, ei.created_at))) AS evaluation_seconds
    FROM user_decisions ud
    JOIN evaluation_items ei ON ei.id = ud.evaluation_item_id
    JOIN latest_suggestion ls ON ls.evaluation_item_id = ud.evaluation_item_id
    LEFT JOIN evaluation_sessions es ON es.id = ei.evaluation_session_id
)
SELECT
    week_start,
    COUNT(*) AS signed_cases,
    COUNT(*) FILTER (WHERE suggested_grade = final_grade) AS agreed_cases,
    ROUND(COUNT(*) FILTER (WHERE suggested_grade = final_grade)::numeric / NULLIF(COUNT(*), 0), 4) AS agreement_rate,
    COUNT(*) FILTER (WHERE decision_type = 'corrected') AS corrected_cases,
    COUNT(*) FILTER (WHERE decision_type = 'uncertain') AS uncertain_cases,
    ROUND(AVG(evaluation_seconds), 2) AS avg_seconds,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY evaluation_seconds)::numeric, 2) AS p50_seconds,
    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY evaluation_seconds)::numeric, 2) AS p95_seconds
FROM base
GROUP BY week_start
ORDER BY week_start DESC
) TO 'docs/metrics/mvp0-weekly.csv' WITH CSV HEADER"
```

## 5) Umbrales iniciales de validación MVP0

Propuesta de criterio de validación (durante 2 semanas consecutivas y al menos 50 casos firmados por semana):

1. **Acuerdo sugerencia vs firma**: `agreement_rate >= 0.70`.
2. **Correcciones manuales**: `corrected_cases / signed_cases <= 0.25`.
3. **Casos en duda**: `uncertain_cases / signed_cases <= 0.10`.
4. **Tiempo de evaluación**:
   - `p50_seconds <= 90`
   - `p95_seconds <= 240`

Si se incumple 1 semana aislada no bloquea; si se incumplen 2 semanas consecutivas, el MVP0 se considera **no validado** y requiere ajuste de rúbrica/UX antes de escalar.

## 6) Auditoría de variantes de `overall_score` vs corrector humano

Para comparar impacto entre:

- `include_memorization` (suma `memorization_risk`)
- `subtract_memorization` (resta `memorization_risk`, sensibilidad)
- `core_only_experimental` (solo `core_idea`, `conceptual_accuracy`, `completeness`)

usar:

```bash
cd backend
npm run audit:overall-variants
```

El script cruza `evaluation_signals` con la última decisión humana (`user_decisions`) y reporta:

- `agreement_rate_pct`: acuerdo contra `final_grade` humano (threshold de PASS en `overall_score >= 0.5`)
- `false_fail_rate_pct`: casos donde la variante predice `FAIL` y humano marcó `PASS`
- `deltas_vs_include_memorization`: diferencia porcentual contra baseline actual
