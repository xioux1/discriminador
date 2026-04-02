# API — `grading-service`

## Endpoint

### `POST /evaluate`

Evalúa una respuesta teórica escrita y devuelve una calificación sugerida con métricas de soporte.

---

## Request

### Content-Type

`application/json`

### Body JSON

```json
{
  "prompt_text": "string",
  "user_answer_text": "string",
  "expected_answer_text": "string",
  "subject": "string (opcional)"
}
```

### Campos

- `prompt_text` (string, **obligatorio**): consigna o pregunta a evaluar.
- `user_answer_text` (string, **obligatorio**): respuesta escrita por el usuario.
- `expected_answer_text` (string, **obligatorio**): respuesta de referencia esperada.
- `subject` (string, **opcional**): materia o contexto temático.

### Validaciones

- Se aplica `trim` a todos los campos de texto antes de validar.
- `prompt_text`: mínimo 10 caracteres no vacíos.
- `user_answer_text`: mínimo 5 caracteres no vacíos.
- `expected_answer_text`: mínimo 10 caracteres no vacíos.
- `subject` (si se envía): entre 1 y 60 caracteres.
- Payload inválido (JSON mal formado o tipos incorrectos) retorna error.

---

## Lógica de evaluación V1

### 1) Evaluador por dimensiones

El servicio evalúa siempre estas 4 dimensiones:

- `core_idea`
- `conceptual_accuracy`
- `completeness`
- `memorization_risk`

### 2) Escala por dimensión

Todas las dimensiones usan exactamente la escala discreta:

- `0.0`
- `0.5`
- `1.0`

Interpretación operativa (resumen):

- `core_idea`: presencia de la idea central.
- `conceptual_accuracy`: ausencia de errores conceptuales graves.
- `completeness`: cobertura de elementos mínimos esperados.
- `memorization_risk`: evidencia de comprensión vs. recitado mecánico.

### 3) Regla de negocio para sugerir `PASS`/`REVIEW`/`FAIL`

Se sugiere `PASS` cuando se cumplen **todas** estas condiciones:

- `core_idea >= 0.5`
- `conceptual_accuracy >= 0.5`
- `completeness >= 0.5`

Se sugiere `REVIEW` cuando falla **solo una** dimensión crítica por margen pequeño (valor `0.0`) y las otras dos están en `>= 0.5`.

En cualquier otro caso, se sugiere `FAIL`.

Notas:

- `memorization_risk` **no bloquea por sí sola** un `PASS`, pero impacta la confianza y se reporta como señal explicativa en la justificación.
- Si hay conflicto fuerte entre dimensiones (por ejemplo, `core_idea = 1.0` pero `conceptual_accuracy = 0.0`), prevalece la regla y el resultado es `FAIL`.

### 4) Cálculo heurístico inicial de `overall_score`

Por defecto, `overall_score` se entrega en rango `0.0–1.0` con la fórmula:

```text
overall_score =
  0.35 * core_idea +
  0.30 * conceptual_accuracy +
  0.25 * completeness +
  0.10 * memorization_risk
```

- Redondeo recomendado: 2 decimales.
- Esta ponderación prioriza núcleo conceptual y corrección por encima del estilo.

Variante experimental habilitable con `ENABLE_EXPERIMENTAL_OVERALL_CORE_ONLY=true`:

```text
overall_score =
  (0.35 * core_idea + 0.30 * conceptual_accuracy + 0.25 * completeness) / 0.90
```

Además, la API devuelve en `signals.overallScoreVariants` un set de variantes para auditoría offline:

- `include_memorization` (base actual)
- `subtract_memorization` (auditoría de sensibilidad)
- `core_only_experimental` (experimental)

### 5) Cálculo heurístico inicial de `model_confidence`

`model_confidence` (rango `0.0–1.0`) se calcula de forma simple con base en coherencia interna:

```text
base_confidence = 0.55

bonus_alignment =
  +0.15 si core_idea y conceptual_accuracy son iguales
  +0.10 si completeness >= 0.5

penalty_conflict =
  -0.20 si core_idea = 1.0 y conceptual_accuracy = 0.0
  -0.10 si memorization_risk = 0.0

model_confidence = clamp(base_confidence + bonus_alignment - penalty_conflict, 0.0, 1.0)
```

Donde `clamp(x, 0.0, 1.0)` limita el resultado al rango permitido.

### 6) Plantilla para `justification_short`

`justification_short` debe ser breve, consistente y accionable. Debe incluir fortaleza, brecha y señal de `memorization_risk`.

```text
"Núcleo: {fortaleza_core}. Precisión: {estado_precision}. Falta: {brecha_completeness}."
```

Reglas de redacción:

- Máximo recomendado: 180 caracteres.
- Siempre mencionar al menos **1 fortaleza** y **1 brecha**.
- Evitar lenguaje ambiguo (“más o menos”, “podría”).

Ejemplos:

- `"Núcleo: correcto. Precisión: sin errores graves. Falta: desarrollar un punto clave del proceso."`
- `"Núcleo: parcial. Precisión: confunde mitosis con meiosis. Falta: diferencia sobre número cromosómico."`

---

## Response

### Body JSON

```json
{
  "suggested_grade": "PASS | REVIEW | FAIL",
  "overall_score": 0.0,
  "dimensions": {
    "core_idea": 0.0,
    "conceptual_accuracy": 0.0,
    "completeness": 0.0,
    "memorization_risk": 0.0
  },
  "justification_short": "string",
  "model_confidence": 0.0
}
```

### Campos

- `suggested_grade` (string): recomendación final (`PASS`, `REVIEW` o `FAIL`).
- `overall_score` (number): score global normalizado en rango `0.0–1.0`.
- `dimensions` (object): sub-scores de la rúbrica V1 (`0.0 | 0.5 | 1.0` por dimensión).
- `justification_short` (string): explicación breve y accionable con plantilla consistente.
- `model_confidence` (number): confianza del modelo en rango `0.0–1.0`.

---

## Códigos de error

### `400 Bad Request`

Se retorna cuando el request no puede procesarse por formato.

Casos típicos:
- JSON mal formado.
- `Content-Type` distinto de `application/json`.
- Tipos de datos inválidos (por ejemplo, número donde se espera string).

Ejemplo:

```json
{
  "error": "bad_request",
  "message": "Invalid JSON payload or unsupported Content-Type.",
  "details": [
    {
      "field": "body",
      "issue": "Malformed JSON"
    }
  ]
}
```

### `422 Unprocessable Entity`

Se retorna cuando el JSON es válido, pero falla reglas de negocio/validación.

Casos típicos:
- `prompt_text` vacío o demasiado corto.
- `user_answer_text` vacío o demasiado corto.
- `expected_answer_text` vacío o demasiado corto.
- `subject` fuera de rango de longitud.

Ejemplo:

```json
{
  "error": "validation_error",
  "message": "One or more fields failed validation.",
  "details": [
    {
      "field": "prompt_text",
      "issue": "Must contain at least 10 non-whitespace characters."
    },
    {
      "field": "user_answer_text",
      "issue": "Must contain at least 5 non-whitespace characters."
    }
  ]
}
```

### `500 Internal Server Error`

Se retorna cuando ocurre una falla inesperada del servicio de evaluación.

Casos típicos:
- Timeout interno de modelo.
- Falla de dependencia interna.
- Error no controlado en el pipeline.

Ejemplo:

```json
{
  "error": "internal_error",
  "message": "Unexpected error while evaluating answer. Please retry."
}
```

---

## Feature flag de preprocessing

### `ENABLE_PREPROCESSING_V2`

Define qué variante de preprocessing usa `scoreEvaluation`:

- `true` → variante `v2`.
- `false` → variante `legacy`.
- sin definir → estrategia de rollout **opción A**:
  - `true` en `APP_ENV`/`NODE_ENV` igual a `staging`, `production` o `prod`;
  - `false` en el resto de entornos.

Recomendación:

- `development` / `test`: `false`.
- `staging` / `production`: `true` (con rollback inmediato posible seteando `false`).

Para auditoría offline, `scoreEvaluationOfflineComparison(payload)` continúa disponible y devuelve ambas rutas (`legacy` y `preprocessed`) en paralelo.

## Ejemplos reales

## 1) Caso PASS

### Request

```http
POST /evaluate
Content-Type: application/json
```

```json
{
  "prompt_text": "Explica qué es la fotosíntesis y por qué es importante para los ecosistemas.",
  "user_answer_text": "La fotosíntesis es el proceso por el cual las plantas usan luz solar, agua y dióxido de carbono para producir glucosa y liberar oxígeno. Es importante porque genera materia orgánica y oxígeno, base de muchas cadenas tróficas.",
  "expected_answer_text": "La fotosíntesis transforma energía lumínica en energía química. Plantas y algas usan CO2 y agua para sintetizar glucosa y liberan oxígeno, sosteniendo la productividad primaria de los ecosistemas.",
  "subject": "Biología"
}
```

### Response (`200 OK`)

```json
{
  "suggested_grade": "PASS",
  "overall_score": 0.90,
  "dimensions": {
    "core_idea": 1.0,
    "conceptual_accuracy": 1.0,
    "completeness": 1.0,
    "memorization_risk": 0.5
  },
  "justification_short": "Núcleo: correcto. Precisión: sin errores graves. Falta: menor detalle en productividad primaria.",
  "model_confidence": 0.80
}
```

## 2) Caso FAIL

### Request

```http
POST /evaluate
Content-Type: application/json
```

```json
{
  "prompt_text": "Define mitosis y meiosis, e indica una diferencia clave entre ambas.",
  "user_answer_text": "Las dos son división celular y en ambas se generan células iguales con el mismo número de cromosomas.",
  "expected_answer_text": "La mitosis produce dos células hijas genéticamente idénticas y conserva el número cromosómico. La meiosis produce cuatro células haploides genéticamente distintas y reduce a la mitad el número de cromosomas.",
  "subject": "Biología celular"
}
```

### Response (`200 OK`)

```json
{
  "suggested_grade": "FAIL",
  "overall_score": 0.18,
  "dimensions": {
    "core_idea": 0.5,
    "conceptual_accuracy": 0.0,
    "completeness": 0.0,
    "memorization_risk": 0.5
  },
  "justification_short": "Núcleo: parcial. Precisión: confunde mitosis con meiosis. Falta: diferencia en resultado y número cromosómico.",
  "model_confidence": 0.45
}
```
