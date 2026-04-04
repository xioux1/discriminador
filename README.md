# discriminador

Plataforma de evaluación teórica escrita con IA, scheduling espaciado por concepto y feedback socrático.

---

## Inicio rápido

```bash
cd backend
cp .env.example .env   # completar variables (ver abajo)
npm install
npm run dev            # arranca servidor + corre migraciones automáticamente
```

Abrir `http://localhost:3000/`

---

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | ✅ | API key de Claude (LLM judge + Socratic + micro-cards) |
| `OPENAI_API_KEY` | ✅ | API key de OpenAI (Whisper speech-to-text) |
| `ENABLE_LLM_JUDGE` | — | `true` activa el juez LLM (default `true` si hay API key) |
| `HOST` | — | Bind host (default `0.0.0.0`) |
| `PORT` | — | Puerto HTTP (default `3000`) |

---

## Arquitectura del sistema

```
ui/main/          → frontend estático (HTML + CSS + JS vanilla)
backend/src/
  routes/         → Express routers (evaluate, decision, socratic, scheduler, …)
  services/       → LLM judge, scoring heurístico, scheduler SM-2, micro-generator
  db/             → Pool PostgreSQL + auto-migration runner
db/migrations/    → SQL migrations numeradas (se aplican automáticamente al arrancar)
```

---

## Tabs de la UI

### Evaluar

Flujo principal de evaluación de respuestas escritas.

1. Ingresá consigna, respuesta y respuesta esperada (+ materia opcional)
2. El sistema evalúa con **LLM judge** (claude-haiku-4-5) calibrado con tus decisiones pasadas
3. Resultado: calificación sugerida, justificación, **conceptos ausentes**
4. Podés **dictar** tu respuesta con el micrófono (Whisper / Firefox-compatible)
5. El campo de respuesta esperada y materia se auto-completan si ya evaluaste esa pregunta antes
6. **Preguntas socráticas**:
   - `REVIEW` → el LLM genera 2 preguntas de profundización → re-evalúa a PASS/FAIL definitivo
   - `FAIL` → genera 2 preguntas educativas para entender el error (calificación no cambia)
7. Firmá la decisión: Aceptar / Corregir a PASS / Corregir a FAIL / Marcar duda
8. Al firmar, la tarjeta se **sincroniza automáticamente con el scheduler**

### Historial

Preguntas agrupadas por materia con tasa de aprobación y dimensión más débil por pregunta.

Al evaluar una pregunta, se muestra su historial colapsable con tendencia, dimensiones promedio y errores frecuentes.

### Estudiar

Scheduler de repaso espaciado a nivel de concepto.

- **Sesión**: cola diaria con micro-conceptos primero, tarjetas completas después
- **Agenda** (`📅 Ver agenda`): vista de todo el calendario — vencidas / hoy / mañana / esta semana / más adelante
  - Por tarjeta: materia, fecha de próxima revisión, intervalo actual, revisiones totales
  - Micro-conceptos anidados bajo su tarjeta padre con su propia fecha
- **Agregar tarjeta**: registro manual de tarjetas (opcional — las decisiones en "Evaluar" sincronizan automáticamente)

---

## Scheduler — cómo funciona

### Algoritmo SM-2 simplificado

| Evento | Intervalo | Ease factor |
|---|---|---|
| PASS | `intervalo × ease` | sin cambio |
| FAIL | 1 día | `max(1.3, ease − 0.2)` |

### Ciclo de micro-tarjetas

```
Tarjeta completa → FAIL con conceptos ausentes
        ↓
LLM genera micro-pregunta para el concepto raíz
        ↓
Micro-tarjeta aparece en la próxima sesión
        ↓
Micro-tarjeta PASS con intervalo ≥ 7 días → archivada (concepto dominado)
Todas las micros archivadas → tarjeta padre se agenda para 3 días
        ↓
Tarjeta completa PASS → archiva todas las micros activas
```

**Principio**: el LLM no genera una micro-tarjeta por cada concepto mecánicamente. Identifica el concepto raíz que bloquea los demás y genera la mínima intervención pedagógica.

---

## Endpoints API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/evaluate` | Evalúa una respuesta (heurística + LLM) |
| `POST` | `/decision` | Firma una decisión + sincroniza scheduler |
| `POST` | `/transcribe` | Speech-to-text vía Whisper |
| `GET` | `/subjects` | Lista materias distintas |
| `GET` | `/expected-answer` | Busca respuesta esperada + materia por consigna |
| `POST` | `/socratic/questions` | Genera preguntas socráticas |
| `POST` | `/socratic/evaluate` | Re-evalúa con respuestas socráticas (modo review) |
| `POST` | `/socratic/feedback` | Feedback educativo (modo fail) |
| `GET` | `/stats/question` | Stats de una pregunta (historial, dimensiones, observaciones) |
| `GET` | `/stats/overview` | Resumen por materia |
| `POST` | `/scheduler/cards` | Registra una tarjeta manualmente |
| `GET` | `/scheduler/cards` | Lista todas las tarjetas |
| `GET` | `/scheduler/session` | Cola de hoy (micro-tarjetas + tarjetas vencidas) |
| `POST` | `/scheduler/review` | Registra resultado de una revisión |
| `GET` | `/scheduler/agenda` | Vista completa del calendario agrupada por fecha |

---

## Migraciones

Las migraciones en `db/migrations/` se corren automáticamente al arrancar el servidor. No hace falta pgAdmin ni psql.

Si una migración ya fue aplicada manualmente antes, el runner la detecta y la marca como hecha sin volver a ejecutarla.

| Archivo | Contenido |
|---|---|
| `0001_initial.sql` | Tablas base: evaluation_items, grade_suggestions, user_decisions |
| `0002_metrics_support.sql` | Soporte de métricas y sesiones |
| `0003_evaluation_signals.sql` | Señales de scoring para auditoría |
| `0004_concept_gaps.sql` | Conceptos ausentes extraídos por el LLM judge |
| `0005_scheduler.sql` | Tablas del scheduler: cards, micro_cards |

---

## Modelo de datos principal

```
evaluation_items     → cada evaluación con su input (consigna, respuesta, esperada, materia)
grade_suggestions    → sugerencia del modelo (LLM o heurístico) por evaluación
user_decisions       → decisión final firmada por el usuario
evaluation_signals   → señales de scoring para auditoría offline
concept_gaps         → conceptos ausentes detectados por el LLM judge
cards                → tarjetas del scheduler (una por pregunta)
micro_cards          → micro-tarjetas por concepto ausente (hijas de cards)
schema_migrations    → tracking de migraciones aplicadas
```
