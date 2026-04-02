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

## Response

### Body JSON

```json
{
  "suggested_grade": "PASS | FAIL",
  "overall_score": 0,
  "dimensions": {
    "core_idea": 0,
    "completeness": 0,
    "conceptual_accuracy": 0,
    "memorization_risk": 0
  },
  "justification_short": "string",
  "model_confidence": 0
}
```

### Campos

- `suggested_grade` (string): recomendación final (`PASS` o `FAIL`).
- `overall_score` (number): score global normalizado en rango `0–100`.
- `dimensions` (object): sub-scores de la rúbrica V1 (`0–100` por dimensión).
- `justification_short` (string): explicación breve y accionable de la sugerencia.
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
  "overall_score": 89,
  "dimensions": {
    "core_idea": 95,
    "completeness": 86,
    "conceptual_accuracy": 90,
    "memorization_risk": 72
  },
  "justification_short": "La respuesta cubre correctamente el mecanismo de la fotosíntesis y su impacto ecosistémico, con buena precisión conceptual y nivel de detalle suficiente.",
  "model_confidence": 0.91
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
  "overall_score": 34,
  "dimensions": {
    "core_idea": 40,
    "completeness": 25,
    "conceptual_accuracy": 20,
    "memorization_risk": 58
  },
  "justification_short": "La respuesta omite la diferencia central entre mitosis y meiosis e incurre en un error conceptual sobre número cromosómico y resultado celular.",
  "model_confidence": 0.88
}
```
