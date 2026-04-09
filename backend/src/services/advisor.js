import Anthropic from '@anthropic-ai/sdk';

const LLM_MODEL = 'claude-sonnet-4-6';
const LLM_MAX_TOKENS = 1500;

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

/**
 * Analiza el progreso de un estudiante en una materia usando el LLM.
 * @param {object} params
 * @param {string} params.subject
 * @param {object|null} params.config  - row de subject_configs
 * @param {Array} params.referenceExams - rows de reference_exams
 * @param {Array} params.cards          - rows de cards (prompt_text, pass_count, review_count)
 * @param {Array} params.decisions      - últimas 50 user_decisions con prompt_text, final_grade, decided_at
 * @param {object} params.activityStats - { total_reviews, pass_rate, streak }
 * @returns {object} JSON analizado por el LLM
 */
export async function analyzeSubject({ subject, config, referenceExams, cards, decisions, activityStats, classNotes = [] }) {
  const client = getClient();

  const today = new Date().toISOString().slice(0, 10);
  const todayDate = new Date(today);

  // Build a rich exam schedule from subject_exam_dates (all exams, not just next)
  const examSchedule = (config?.exam_dates || []).map(e => {
    const d = new Date(e.exam_date);
    return {
      label:     e.label,
      exam_type: e.exam_type,
      exam_date: e.exam_date,
      scope_pct: e.scope_pct,
      days_until: Math.ceil((d - todayDate) / 86400000)
    };
  });

  // Next upcoming exam (for quick access)
  const nextExam = examSchedule.find(e => e.days_until >= 0) || null;

  const userContent = JSON.stringify({
    subject,
    today,
    next_exam: nextExam,
    exam_schedule: examSchedule,   // all parciales + final
    syllabus: config?.syllabus_text || '',
    // Per-class notes (new structured format) + legacy single-blob fallback
    class_notes: classNotes.length > 0
      ? classNotes.map(n => `[${n.title || 'Sin título'}]\n${n.content}`).join('\n\n')
      : (config?.notes_text || ''),
    reference_exams: referenceExams.map(e => ({
      label: e.label,
      year: e.year,
      exam_type: e.exam_type,
      content: e.content_text
    })),
    flashcards: cards.map(c => ({
      prompt: c.prompt_text,
      pass_count: Number(c.pass_count),
      review_count: Number(c.review_count)
    })),
    recent_decisions: decisions.map(d => ({
      prompt: d.prompt_text,
      grade: d.final_grade,
      date: d.decided_at
    })),
    activity_stats: activityStats
  }, null, 2);

  const response = await client.messages.create({
    model: LLM_MODEL,
    max_tokens: LLM_MAX_TOKENS,
    temperature: 0,
    system: `Sos un tutor universitario experto que analiza el progreso de un estudiante.
Tenés acceso al plan de estudios, exámenes anteriores y el historial de estudio del alumno.
Tu análisis debe ser concreto, accionable y en español.

Si el input incluye "class_notes" (apuntes del estudiante), usálos para identificar qué temas
enfatizó el docente en clase — esos temas tienen mayor probabilidad de aparecer en el examen
aunque no estén destacados en el programa oficial.

El input puede incluir "exam_schedule": lista de todos los parciales y final con su fecha,
días restantes y scope_pct (% del temario que cubre ese examen).
Usá esto para dar contexto preciso: "tenés el 1er Parcial en 10 días que cubre el 50% del temario",
no "tenés un examen en 10 días y cubriste el 40% del total" si el primer parcial es solo el 50%.

Respondé ÚNICAMENTE con un JSON válido con esta estructura exacta:
{
  "coverage_pct": <número 0-100, cobertura respecto al scope del PRÓXIMO examen, no el temario total>,
  "covered_topics": ["tema 1", "tema 2", ...],
  "missing_topics": ["tema A", "tema B", ...],
  "exam_gaps": ["concepto X aparece frecuentemente en exámenes pero no fue practicado", ...],
  "days_until_exam": <número o null, días hasta el próximo examen>,
  "next_exam_label": "<nombre del próximo examen, ej: '1er Parcial'>",
  "next_exam_scope_pct": <scope_pct del próximo examen o null>,
  "pace_ok": <true|false>,
  "pace_message": "<evaluación del ritmo actual dado la fecha del próximo examen y su scope>",
  "priorities": ["1. ...", "2. ...", "3. ..."],
  "summary": "<resumen ejecutivo de 2-3 oraciones usando el contexto correcto del examen>"
}`,
    messages: [
      {
        role: 'user',
        content: userContent
      }
    ]
  });

  const raw = response.content[0]?.text?.trim() || '{}';

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_e) {
    parsed = { summary: raw, coverage_pct: 0, covered_topics: [], missing_topics: [], exam_gaps: [], priorities: [], pace_ok: true, pace_message: '' };
  }

  // Always set days_until_exam from our calculation (more reliable than LLM arithmetic)
  parsed.days_until_exam     = nextExam?.days_until ?? null;
  parsed.next_exam_label     = parsed.next_exam_label     || nextExam?.label     || null;
  parsed.next_exam_scope_pct = parsed.next_exam_scope_pct || nextExam?.scope_pct || null;

  return parsed;
}
