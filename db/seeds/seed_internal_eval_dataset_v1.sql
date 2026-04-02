-- Seed del dataset interno versionado para evaluación offline.
-- Fuente canónica: db/seeds/internal_eval_dataset_v1.json

BEGIN;

WITH dataset AS (
  SELECT *
  FROM (
    VALUES
      ('ie-001','rn','¿Para qué se usa train_test_split con stratify en clasificación?','Se usa para dividir train y test manteniendo proporción de clases y evitando sesgo de evaluación.','Separa datos en entrenamiento y prueba, y con stratify mantiene el balance por clase.','{"core_idea":1.0,"conceptual_accuracy":1.0,"completeness":0.5,"memorization_risk":0.5}'::jsonb,'PASS'),
      ('ie-002','rn','¿Qué representa overfitting?','Es cuando el modelo aprende ruido del train y pierde generalización en test.','Cuando memoriza los ejemplos de entrenamiento y después no generaliza.','{"core_idea":1.0,"conceptual_accuracy":1.0,"completeness":0.5,"memorization_risk":0.0}'::jsonb,'PASS'),
      ('ie-003','rn','Diferencia entre precisión y recall.','Precisión minimiza falsos positivos, recall minimiza falsos negativos.','La precisión evalúa positivos correctos sobre positivos predichos y recall positivos detectados sobre reales.','{"core_idea":1.0,"conceptual_accuracy":1.0,"completeness":1.0,"memorization_risk":0.5}'::jsonb,'PASS'),
      ('ie-004','rn','¿Qué es una matriz de confusión?','Tabla de verdaderos/ falsos positivos y negativos para analizar errores del clasificador.','Es una tabla con aciertos y errores, separando verdaderos y falsos positivos/negativos.','{"core_idea":0.5,"conceptual_accuracy":0.5,"completeness":0.5,"memorization_risk":0.5}'::jsonb,'PASS'),
      ('ie-005','rn','¿Por qué estandarizar variables?','Para llevar features a escala comparable y estabilizar entrenamiento en modelos sensibles a magnitud.','Porque evita que una variable con escala grande domine el ajuste del modelo.','{"core_idea":0.5,"conceptual_accuracy":0.5,"completeness":0.0,"memorization_risk":0.5}'::jsonb,'PASS'),
      ('ie-006','rn','¿Qué es regularización L2?','Agrega penalización al tamaño de pesos para reducir sobreajuste.','Es una penalización para que los pesos no crezcan tanto y el modelo generalice mejor.','{"core_idea":0.5,"conceptual_accuracy":0.5,"completeness":0.5,"memorization_risk":0.0}'::jsonb,'PASS'),
      ('ie-007','rn','¿Qué es underfitting?','Modelo demasiado simple que no captura patrones, falla en train y test.','Pasa cuando el modelo no aprende suficiente y rinde mal incluso en entrenamiento.','{"core_idea":0.5,"conceptual_accuracy":0.5,"completeness":0.0,"memorization_risk":0.0}'::jsonb,'PASS'),
      ('ie-008','rn','¿Qué hace un learning rate?','Controla el tamaño del paso en descenso de gradiente.','No estoy seguro, creo que cambia cuántas capas tiene la red.','{"core_idea":0.0,"conceptual_accuracy":0.0,"completeness":0.0,"memorization_risk":1.0}'::jsonb,'FAIL'),
      ('ie-009','rn','¿Qué indica AUC-ROC?','Capacidad del modelo para discriminar clases a distintos umbrales.','Es un error promedio de regresión, no aplica a clasificación.','{"core_idea":0.0,"conceptual_accuracy":0.0,"completeness":0.0,"memorization_risk":0.5}'::jsonb,'FAIL'),
      ('ie-010','rn','¿Qué es validación cruzada?','Particionar en folds para estimar performance robusta.','Es partir en varios subconjuntos, entrenar/validar rotando y promediar resultados.','{"core_idea":1.0,"conceptual_accuracy":0.5,"completeness":0.5,"memorization_risk":1.0}'::jsonb,'PASS')
  ) AS t(case_id, subject, prompt_text, expected_answer_text, user_answer_text, dimensions, human_final_grade)
), upsert_items AS (
  INSERT INTO evaluation_items (source_system, source_record_id, input_payload, evaluator_context)
  SELECT
    'internal_dataset_v1',
    d.case_id,
    jsonb_build_object(
      'prompt_text', d.prompt_text,
      'expected_answer_text', d.expected_answer_text,
      'user_answer_text', d.user_answer_text
    ),
    jsonb_build_object('subject', d.subject, 'dataset_version', '2026-04-02.v1')
  FROM dataset d
  ON CONFLICT (source_system, source_record_id) DO UPDATE
    SET input_payload = EXCLUDED.input_payload,
        evaluator_context = EXCLUDED.evaluator_context,
        updated_at = NOW()
  RETURNING id, source_record_id
), resolved_items AS (
  SELECT id, source_record_id FROM upsert_items
  UNION
  SELECT id, source_record_id
  FROM evaluation_items
  WHERE source_system = 'internal_dataset_v1'
), upsert_signals AS (
  INSERT INTO evaluation_signals (
    evaluation_item_id,
    evaluation_id,
    prompt_text,
    subject,
    keyword_coverage,
    answer_length_ratio,
    lexical_similarity,
    dimensions,
    suggested_grade,
    created_at
  )
  SELECT
    ri.id,
    ('00000000-0000-0000-0000-' || lpad(substr(md5(d.case_id), 1, 12), 12, '0'))::uuid,
    d.prompt_text,
    d.subject,
    0.5,
    0.5,
    0.5,
    d.dimensions,
    d.human_final_grade,
    NOW()
  FROM dataset d
  JOIN resolved_items ri ON ri.source_record_id = d.case_id
  ON CONFLICT (evaluation_id) DO UPDATE
    SET dimensions = EXCLUDED.dimensions,
        suggested_grade = EXCLUDED.suggested_grade,
        created_at = EXCLUDED.created_at
  RETURNING evaluation_item_id
)
INSERT INTO user_decisions (evaluation_item_id, final_grade, decision_type, reason, decided_at)
SELECT
  ri.id,
  d.human_final_grade,
  'corrected',
  'Etiqueta humana canónica (dataset interno versionado)',
  NOW()
FROM dataset d
JOIN resolved_items ri ON ri.source_record_id = d.case_id
WHERE NOT EXISTS (
  SELECT 1
  FROM user_decisions ud
  WHERE ud.evaluation_item_id = ri.id
    AND ud.reason = 'Etiqueta humana canónica (dataset interno versionado)'
);

COMMIT;
