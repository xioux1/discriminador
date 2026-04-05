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
export async function analyzeSubject({ subject, config, referenceExams, cards, decisions, activityStats }) {
  const client = getClient();

  const today = new Date().toISOString().slice(0, 10);
  let daysUntilExam = null;
  if (config?.exam_date) {
    const examDate = new Date(config.exam_date);
    const todayDate = new Date(today);
    daysUntilExam = Math.ceil((examDate - todayDate) / (1000 * 60 * 60 * 24));
  }

  const userContent = JSON.stringify({
    subject,
    today,
    days_until_exam: daysUntilExam,
    exam_type: config?.exam_type || null,
    syllabus: config?.syllabus_text || '',
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

Respondé ÚNICAMENTE con un JSON válido con esta estructura exacta:
{
  "coverage_pct": <número 0-100>,
  "covered_topics": ["tema 1", "tema 2", ...],
  "missing_topics": ["tema A", "tema B", ...],
  "exam_gaps": ["concepto X aparece frecuentemente en exámenes pero no fue practicado", ...],
  "days_until_exam": <número o null>,
  "pace_ok": <true|false>,
  "pace_message": "<evaluación del ritmo actual dado la fecha del examen>",
  "priorities": ["1. ...", "2. ...", "3. ..."],
  "summary": "<resumen ejecutivo de 2-3 oraciones>"
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

  // Always set days_until_exam from our calculation (more reliable)
  parsed.days_until_exam = daysUntilExam;

  return parsed;
}
