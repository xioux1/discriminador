# MVP0 Signoff — Evaluación teórica escrita

- **Documento generado:** 2026-04-02 (UTC)
- **Estado de signoff MVP0:** **NOT READY**

> MVP0 se marca como **ready** únicamente si **todos** los criterios de aceptación de `docs/mvp0-scope.md` están cumplidos y existe evidencia verificable.

## 1) DoD checklist (fuente: `docs/mvp0-scope.md`)

- [x] Existe pantalla única funcional con inputs, botón `Evaluar` y bloque de resultado.
- [x] La evaluación devuelve calificación sugerida y justificación breve.
- [x] El usuario puede firmar decisión final (aceptar/corregir/duda).
- [x] Se persisten inputs + resultado + firma + timestamp.
- [ ] Se verifica flujo punta a punta con casos de prueba básicos.
- [ ] Se mide y registra latencia p50/p95.
- [ ] Se valida recuperación de datos persistidos.
- [x] Quedan explícitamente excluidos Anki, audio/STT, scheduler, multiusuario y mobile.

### Evidencia usada para el checklist

- Cobertura funcional y flujo esperado documentados en:
  - `docs/mvp0-scope.md`
  - `docs/wireframes/mvp0.md`
  - `docs/api/grading-service.md`
  - `scripts/qa/run_mvp0_suite.sh`
- No se encontró reporte ejecutado (`docs/qa/mvp0-qa-report-latest.md`) en el repositorio.
- No se adjuntaron trazas/resultados de ejecución del suite QA ni extracción de datos de DB.

## 2) Example request/response payloads usados en validación

> Basados en la definición de API y en los payloads construidos por `scripts/qa/run_mvp0_suite.sh`.

### 2.1 `POST /evaluate` — request válido (ejemplo)

```json
{
  "prompt_text": "Define photosynthesis in one sentence.",
  "user_answer_text": "Photosynthesis converts light into chemical energy in plants.",
  "expected_answer_text": "Photosynthesis is the process where plants use light, water and CO2 to make glucose and release oxygen.",
  "subject": "QA-MVP0-EXAMPLE-02"
}
```

### 2.2 `POST /evaluate` — response esperada (shape)

```json
{
  "suggested_grade": "PASS",
  "overall_score": 0.75,
  "dimensions": {
    "core_idea": 1.0,
    "conceptual_accuracy": 1.0,
    "completeness": 0.5,
    "memorization_risk": 0.5
  },
  "justification_short": "Núcleo: correcto. Precisión: sin errores graves. Falta: desarrollar un punto clave.",
  "model_confidence": 0.8
}
```

### 2.3 `POST /decision` — request válido (ejemplo acción `accept`)

```json
{
  "prompt_text": "Define photosynthesis in one sentence.",
  "user_answer_text": "Photosynthesis converts light into chemical energy in plants.",
  "expected_answer_text": "Photosynthesis is the process where plants use light, water and CO2 to make glucose and release oxygen.",
  "subject": "QA-MVP0-EXAMPLE-02",
  "evaluation_result": {
    "suggested_grade": "PASS",
    "overall_score": 0.75,
    "dimensions": {
      "core_idea": 1.0,
      "conceptual_accuracy": 1.0,
      "completeness": 0.5,
      "memorization_risk": 0.5
    },
    "justification_short": "Núcleo: correcto. Precisión: sin errores graves. Falta: desarrollar un punto clave.",
    "model_confidence": 0.8
  },
  "action": "accept",
  "final_grade": "PASS",
  "accepted_suggestion": true,
  "correction_reason": null
}
```

### 2.4 `POST /decision` — response esperada (shape)

```json
{
  "status": "saved",
  "success": true,
  "decision": {
    "action": "accept"
  }
}
```

## 3) DB evidence (persistencia)

### Resultado

**Sin evidencia ejecutada en este corte de repositorio.**

No hay en el repo:
- snapshot de filas persistidas,
- IDs reales de `evaluation_items`, `grade_suggestions`, `user_decisions`,
- ni export de consultas del bloque de verificación de `scripts/qa/run_mvp0_suite.sh`.

### Qué debe incluirse para cerrar este punto

Para declarar persistencia validada, se requiere adjuntar al menos:
1. Conteos por suite (esperado 9/9/9 para casos exitosos del script).
2. Muestra de IDs enlazados por caso, por ejemplo:
   - `evaluation_items.id`
   - `grade_suggestions.id` + `evaluation_item_id`
   - `user_decisions.id` + `evaluation_item_id`
3. Verificación de campos requeridos persistidos:
   - consigna, respuesta usuario, respuesta esperada,
   - resultado evaluación,
   - decisión final firmada,
   - timestamp.

## 4) Latency table (p50/p95) + fecha de corrida

| Test run date (UTC) | Source | p50 (ms) | p95 (ms) | Threshold (scope) | Resultado |
|---|---|---:|---:|---|---|
| 2026-04-02 | N/A (sin ejecución registrada) | N/A | N/A | p50 <= 2000, p95 <= 4000 | **NO EVIDENCE** |

## 5) Open risks + Out-of-scope explícito

### Open risks

1. **Riesgo de falso positivo de readiness:** hay implementación y script, pero sin evidencia ejecutada/versionada no se puede demostrar cumplimiento de aceptación.
2. **Riesgo de performance desconocida:** sin p50/p95 medidos en entorno objetivo, no hay validación de latencia percibida.
3. **Riesgo de persistencia no auditada:** sin muestras de filas/IDs enlazados no se confirma trazabilidad end-to-end.
4. **Riesgo de regresión sin señal:** falta reporte QA publicado (`docs/qa/mvp0-qa-report-latest.md`) como artefacto de control.

### Out-of-scope (explícito)

Se mantienen fuera de MVP0, según `docs/mvp0-scope.md`:
- Integración con Anki.
- Audio / STT.
- Scheduler.
- Multiusuario.
- Aplicación mobile.

## Decisión final de signoff

- **MVP0 readiness:** **NOT READY**.
- **Motivo:** no hay evidencia verificable en repositorio para completar los criterios de aceptación de:
  - flujo punta a punta en 10 casos consecutivos,
  - latencia p50/p95 medida,
  - recuperación de datos persistidos con pruebas.

