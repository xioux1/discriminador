# discriminador
# Product Spec V1 — Asistente de Evaluación Teórica Escrita

## Ejecución local (backend + UI estática)

La UI (`ui/main`) se sirve desde el backend Express para mantener **mismo origen** y evitar problemas de CORS en los endpoints `/evaluate` y `/decision`.

Secuencia recomendada:

1. Configurar variables de entorno del backend (mínimo `DATABASE_URL`; opcionales `HOST` y `PORT`).
2. Instalar dependencias del backend:
   ```bash
   cd backend
   npm install
   ```
3. Iniciar el backend (también sirve la UI estática):
   ```bash
   npm run dev
   ```
4. Abrir en navegador `http://localhost:3000/` (o el `PORT` configurado).
5. Desde esa misma URL, la UI consume:
   * `POST /evaluate`
   * `POST /decision`

## 1. Propósito

Construir una plataforma asistida para evaluación de respuestas teóricas escritas, donde el usuario pegue manualmente la consigna, su respuesta y la respuesta esperada, el sistema genere una calificación sugerida con justificación, y la decisión final quede en manos del usuario.

La V1 no se integra con Anki, no usa audio y no automatiza scheduling. Su objetivo es validar el flujo de evaluación escrita, sugerencia de calificación y firma manual.

## 2. Problema

En el flujo actual de estudio teórico escrito:

* el usuario responde en texto libre;
* la evaluación sigue siendo manual y poco estructurada;
* no queda un registro sistemático de discrepancias entre “respuesta correcta”, “respuesta entendida”, “respuesta memorizada” y “respuesta parcialmente correcta”;
* el usuario no tiene una capa intermedia que proponga una corrección consistente antes de decidir la nota final.

La V1 busca validar si un discriminador teórico escrito aporta valor real antes de sumar complejidad de audio, Anki o scheduling.

## 3. Objetivo de negocio / producto

Validar un sistema que:

1. permita ingresar manualmente consigna, respuesta del usuario y respuesta esperada;
2. evalúe respuestas teóricas escritas con una rúbrica explícita;
3. genere una sugerencia de calificación con justificación;
4. permita firma manual del usuario;
5. persista discrepancias entre sugerencia y decisión final;
6. genere datos estructurados para una futura V2 con sesiones, integración con Anki y eventual oralidad.

## 4. Usuario objetivo

Usuario principal inicial: Simón.

Perfil:

* estudia con preguntas teóricas y respuestas abiertas;
* puede pegar manualmente consigna, respuesta y back;
* prioriza foco, baja fricción y criterio estable de corrección;
* quiere una herramienta formal y modular.

## 5. Alcance V1

### Incluye

* Ingreso manual de consigna, respuesta del usuario y respuesta esperada.
* Evaluación por ítem teórico escrito.
* Sugerencia de calificación con justificación.
* Firma manual del usuario.
* Persistencia de resultados y discrepancias.
* Métricas básicas de calidad del sistema.

### No incluye

* Integración con Anki.
* Audio o speech-to-text.
* Scheduler propio.
* Clusterización activa.
* Generación automática de variantes.
* Calificación autónoma sin firma.
* Mobile app.
* Multiusuario.

## 6. Caso inicial recomendado

Dominio piloto: preguntas teóricas abiertas respondidas por escrito.

Criterios de elección:

* utilidad real de un discriminador semántico;
* respuestas correctas posibles con redacción no idéntica;
* posibilidad de distinguir comprensión de recitado;
* facilidad para construir una rúbrica estable.

## 7. Principios de diseño

1. **La firma humana es obligatoria.**
2. **Primero se valida el discriminador teórico escrito.**
3. **La arquitectura debe ser modular desde el inicio.**
4. **La V1 evita complejidad accesoria.**
5. **La respuesta esperada es ingresada manualmente como referencia.**

## 8. Flujo principal

1. El usuario abre la aplicación.
2. Pega la consigna.
3. Pega su respuesta.
4. Pega la respuesta esperada o back.
5. Ejecuta la evaluación.
6. El sistema genera:

   * sugerencia de calificación;
   * score general;
   * dimensiones de evaluación;
   * justificación breve.
7. El usuario:

   * acepta;
   * corrige;
   * o marca duda.
8. El sistema registra la decisión final como dato canónico.

## 9. Arquitectura V1

### 9.1 Módulos

#### A. `input-ui`

Responsabilidades:

* recibir consigna, respuesta del usuario y respuesta esperada;
* validar formato mínimo de entrada.

#### B. `grading-service`

Responsabilidades:

* comparar respuesta del usuario con la respuesta esperada;
* aplicar la rúbrica V1;
* producir sugerencia estructurada.

#### C. `signoff-ui`

Responsabilidades:

* mostrar sugerencia, score y justificación;
* permitir aceptación o corrección manual;
* registrar decisión final.

#### D. `storage`

Responsabilidades:

* persistir inputs, sugerencias, decisiones y métricas.

## 10. Modelo de datos inicial

### `EvaluationItem`

* `id`
* `prompt_text`
* `user_answer_text`
* `expected_answer_text`
* `subject` (opcional)
* `created_at`

### `GradeSuggestion`

* `id`
* `evaluation_item_id`
* `suggested_grade` (`pass`, `fail`, opcionalmente `partial`)
* `overall_score`
* `dimensions_json`
* `justification_short`
* `model_confidence`
* `created_at`

### `UserDecision`

* `id`
* `evaluation_item_id`
* `final_grade`
* `accepted_suggestion`
* `correction_reason` (opcional)
* `finalized_at`

### `EvaluationSession`

* `id`
* `started_at`
* `ended_at`
* `subject`
* `deck_filter` (opcional)

## 11. Rúbrica V1 del discriminador

### Para teoría escrita

Dimensiones:

* `core_idea`
* `completeness`
* `conceptual_accuracy`
* `memorization_risk`

Regla sugerida de PASS:

* idea central correcta;
* sin confusión conceptual grave;
* formulación suficiente aunque no sea textual.

## 12. Estados del sistema

### Estados de validación

* `accepted_as_suggested`
* `manually_corrected`
* `flagged_uncertain`

## 13. UI mínima

### Pantalla principal

Campos:

* consigna;
* respuesta del usuario;
* respuesta esperada;
* botón `Evaluar`.

### Resultado

Muestra:

* sugerencia de calificación;
* score;
* justificación en una línea;
* dimensiones del score;
* acciones: `Aceptar`, `Corregir`, `Duda`.

## 14. Métricas de éxito V1

### Producto

* el flujo de evaluación es simple y usable;
* la corrección sugerida aporta valor respecto a la corrección manual pura;
* la firma final del usuario es rápida.

### Calidad

* acuerdo modelo-usuario aceptable en dominio piloto;
* baja tasa de falsos PASS críticos;
* justificativos útiles para revisión humana.

### Técnica

* persistencia correcta de inputs, sugerencias y decisiones;
* ejecución estable del discriminador;
* interfaz suficientemente rápida para uso real.

## 15. Riesgos principales

1. Rúbrica demasiado ambigua.
2. Justificaciones del modelo poco útiles.
3. Exceso de complejidad temprana.
4. Criterio inestable entre casos similares.

## 16. Estrategia de mitigación

* limitar el caso inicial a teoría escrita;
* usar una rúbrica corta y explícita;
* mantener la firma humana obligatoria;
* no introducir clusters ni scheduler en V1;
* no introducir audio ni integración con Anki en V1.

## 17. Hitos de desarrollo

### Hito 0 — Especificación

* Product spec
* Rúbrica V1
* Modelo de datos
* Caso piloto

### Hito 1 — UI de entrada

* campos para consigna, respuesta y back
* validaciones mínimas

### Hito 2 — Grading básico

* pass/fail sugerido
* score por dimensiones
* justificación corta

### Hito 3 — Firma manual

* aceptar/corregir
* persistir decisión final

### Hito 4 — Métricas

* acuerdo modelo-usuario
* errores frecuentes
* tiempos por evaluación

## 18. Criterio de salida de V1

La V1 se considera validada si:

* puede usarse en sesiones reales de evaluación teórica escrita;
* produce sugerencias razonables en el dominio piloto;
* la firma manual es simple;
* genera datos suficientemente buenos para diseñar V2.

## 19. Próxima evolución (V2, fuera de alcance)

* sesiones en lote;
* import desde Anki o archivos;
* oralidad y speech-to-text;
* pseudo-clusters por metadata externa;
* scheduler híbrido.

## 20. Rúbrica V1 detallada

### 20.1 Objetivo de la rúbrica

La rúbrica V1 busca evaluar respuestas teóricas escritas de forma consistente y útil para firma humana posterior. No intenta reemplazar al evaluador humano; intenta producir una sugerencia razonable, trazable y corregible.

### 20.2 Dimensiones

#### A. `core_idea`

Evalúa si la respuesta contiene la idea central que hace correcta a la definición o explicación.

Escala sugerida:

* `1.0`: expresa claramente la idea central;
* `0.5`: expresa parte del núcleo pero de forma incompleta o difusa;
* `0.0`: no expresa la idea central o expresa una idea equivocada.

#### B. `conceptual_accuracy`

Evalúa si la respuesta evita errores conceptuales graves.

Escala sugerida:

* `1.0`: sin errores conceptuales relevantes;
* `0.5`: contiene simplificaciones o imprecisiones menores;
* `0.0`: contiene una confusión conceptual grave.

#### C. `completeness`

Evalúa si la respuesta incluye los elementos mínimos esperados para que pueda darse por válida.

Escala sugerida:

* `1.0`: cubre lo esencial;
* `0.5`: cubre el núcleo, pero falta una parte importante;
* `0.0`: la respuesta queda demasiado incompleta.

#### D. `memorization_risk`

Evalúa si la respuesta parece recitada sin verdadero control conceptual.

Escala sugerida:

* `1.0`: formulación flexible, consistente y con señales de comprensión;
* `0.5`: respuesta correcta pero rígida o mecánica;
* `0.0`: fuerte sospecha de recitado vacío o ensamblado superficial.

### 20.3 Regla de PASS / FAIL

#### PASS

Una respuesta debe sugerirse como PASS si:

* `core_idea >= 0.5`, y
* `conceptual_accuracy >= 0.5`, y
* no hay error conceptual grave, y
* la completitud es suficiente para considerar que la pregunta fue respondida.

#### FAIL

Una respuesta debe sugerirse como FAIL si ocurre alguna de estas condiciones:

* falta la idea central;
* hay confusión conceptual grave;
* la respuesta es demasiado incompleta;
* la formulación parece correcta en superficie, pero contradice el núcleo esperado.

### 20.4 Criterios de no penalización

El sistema no debe penalizar por sí mismo:

* redacción distinta a la respuesta esperada;
* menor elegancia verbal;
* orden diferente de exposición;
* uso de sinónimos válidos;
* falta de textualidad exacta si el significado es correcto.

### 20.5 Criterios de penalización

El sistema sí debe penalizar:

* ausencia de la idea central;
* contradicciones con la respuesta esperada;
* mezcla de conceptos cercanos pero distintos;
* enumeración vacía sin explicar el núcleo;
* respuesta que parece aprender la forma pero no el contenido.

### 20.6 Salida estructurada sugerida

El discriminador debe devolver una estructura como esta:

```json
{
  "suggested_grade": "pass",
  "overall_score": 0.74,
  "dimensions": {
    "core_idea": 1.0,
    "conceptual_accuracy": 0.5,
    "completeness": 0.5,
    "memorization_risk": 0.5
  },
  "justification_short": "La idea central está, pero falta una precisión importante sobre el alcance del concepto.",
  "model_confidence": 0.81
}
```

### 20.7 Plantilla de justificación breve

La justificación corta debe responder, en una línea, estas dos preguntas:

* ¿qué estuvo bien?
* ¿qué faltó o qué estuvo mal?

Formato sugerido:

* `Captó la idea central, pero omitió ...`
* `La respuesta es parcialmente correcta, pero confunde ... con ...`
* `La definición mantiene el núcleo correcto y no presenta errores conceptuales graves.`

## 21. MVP V0 — Pantalla única

### 21.1 Objetivo

Construir una primera interfaz mínima que permita probar la utilidad del discriminador teórico escrito sin agregar sesiones, Anki, audio ni procesamiento en background.

### 21.2 Componentes de pantalla

#### Bloque de entrada

Campos:

* `Consigna`
* `Respuesta del usuario`
* `Respuesta esperada`
* `Materia` (opcional)
* `Tags` (opcional)

Botón principal:

* `Evaluar`

#### Bloque de resultado

Se muestra después de evaluar:

* `Calificación sugerida`
* `Score general`
* `Dimensiones`
* `Justificación breve`
* `Confianza del modelo`

Acciones:

* `Aceptar sugerencia`
* `Corregir a PASS`
* `Corregir a FAIL`
* `Marcar duda`

#### Bloque opcional de detalle

Expandible:

* comparación entre respuesta del usuario y respuesta esperada;
* observaciones adicionales;
* metadata del ítem.

### 21.3 Flujo exacto

1. El usuario pega la consigna.
2. El usuario pega su respuesta.
3. El usuario pega la respuesta esperada.
4. Presiona `Evaluar`.
5. El sistema ejecuta el discriminador.
6. La interfaz muestra el resultado estructurado.
7. El usuario firma la decisión final.
8. El sistema persiste input, sugerencia y decisión.

### 21.4 Persistencia mínima del MVP

Por cada evaluación, se debe guardar:

* consigna;
* respuesta del usuario;
* respuesta esperada;
* salida del discriminador;
* decisión final del usuario;
* timestamp.

### 21.5 Criterios de aceptación del MVP

El MVP V0 se considera aceptable si:

* permite completar evaluaciones de punta a punta;
* la interfaz es suficientemente rápida y clara;
* la justificación sugerida resulta útil;
* la firma manual se hace en pocos segundos;
* se generan datos reutilizables para iterar la rúbrica.

## 22. Próximo entregable de ingeniería

El siguiente entregable técnico debería ser:

* wireframe simple de la pantalla única;
* esquema de API del `grading-service`;
* esquema SQL o modelo de persistencia inicial;
* lista corta de 20 preguntas piloto para prueba.

## UI principal (MVP V0)

Se agregó un módulo base en `ui/main/` con:

- formulario con validación local;
- integración con `POST /evaluate`;
- render de respuesta estructurada (sugerencia, score, dimensiones, justificación y confianza);
- acciones de firma (`Aceptar sugerencia`, `Corregir a PASS`, `Corregir a FAIL`, `Marcar duda`) con envío al backend vía `POST /decision`;
- feedback de guardado y bloqueo de doble envío durante evaluación/guardado.

## Backend module (`backend/`)

El módulo backend expone una API HTTP base para integrarse con `ui/main/main.js`.

### Requisitos

1. Node.js 20+.
2. Copiar variables de entorno:

```bash
cd backend
cp .env.example .env
```

### Variables de entorno

- `HOST`: host de bind del servidor (default `0.0.0.0`).
- `PORT`: puerto HTTP (default `3000`).
- `DATABASE_URL`: connection string de base de datos (obligatoria).

### Ejecutar en local

```bash
cd backend
npm install
npm run start
```

Servidor local esperado:

- `http://localhost:3000`

### Endpoints

- `GET /health`
- `POST /evaluate`
- `POST /decision`
