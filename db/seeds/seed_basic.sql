-- Seed básico para pruebas locales.

BEGIN;

INSERT INTO evaluation_items (source_system, source_record_id, input_payload, evaluator_context)
VALUES
    (
        'lms',
        'submission-001',
        '{"student_id":"stu_123","assignment_id":"asg_001","answer_text":"La fotosíntesis convierte luz en energía química."}',
        '{"course":"BIO101","language":"es"}'
    ),
    (
        'lms',
        'submission-002',
        '{"student_id":"stu_456","assignment_id":"asg_001","answer_text":"La fotosíntesis ocurre en las mitocondrias."}',
        '{"course":"BIO101","language":"es"}'
    )
ON CONFLICT (source_system, source_record_id) DO NOTHING;

INSERT INTO grade_suggestions (evaluation_item_id, suggested_grade, confidence, model_name, model_version, explanation)
SELECT id, 'A', 0.9300, 'discriminador', 'v0', 'Respuesta completa y correcta.'
FROM evaluation_items ei
WHERE ei.source_system = 'lms'
  AND ei.source_record_id = 'submission-001'
  AND NOT EXISTS (
      SELECT 1
      FROM grade_suggestions gs
      WHERE gs.evaluation_item_id = ei.id
        AND gs.model_name = 'discriminador'
        AND gs.model_version = 'v0'
  );

INSERT INTO grade_suggestions (evaluation_item_id, suggested_grade, confidence, model_name, model_version, explanation)
SELECT id, 'D', 0.8700, 'discriminador', 'v0', 'Confusión de orgánulos clave.'
FROM evaluation_items ei
WHERE ei.source_system = 'lms'
  AND ei.source_record_id = 'submission-002'
  AND NOT EXISTS (
      SELECT 1
      FROM grade_suggestions gs
      WHERE gs.evaluation_item_id = ei.id
        AND gs.model_name = 'discriminador'
        AND gs.model_version = 'v0'
  );

INSERT INTO user_decisions (evaluation_item_id, final_grade, decision_type, reason)
SELECT id, 'A', 'accepted', NULL
FROM evaluation_items ei
WHERE ei.source_system = 'lms'
  AND ei.source_record_id = 'submission-001'
  AND NOT EXISTS (
      SELECT 1
      FROM user_decisions ud
      WHERE ud.evaluation_item_id = ei.id
        AND ud.final_grade = 'A'
        AND ud.decision_type = 'accepted'
  );

INSERT INTO user_decisions (evaluation_item_id, final_grade, decision_type, reason)
SELECT id, 'C', 'corrected', 'Se reconoce parcialmente el proceso pero contiene error conceptual importante.'
FROM evaluation_items ei
WHERE ei.source_system = 'lms'
  AND ei.source_record_id = 'submission-002'
  AND NOT EXISTS (
      SELECT 1
      FROM user_decisions ud
      WHERE ud.evaluation_item_id = ei.id
        AND ud.final_grade = 'C'
        AND ud.decision_type = 'corrected'
  );

COMMIT;
