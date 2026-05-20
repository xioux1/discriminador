import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let raw = fence ? fence[1] : text;
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s !== -1 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function isValidDate(str) {
  if (!str || typeof str !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str));
}

async function callLLM(text) {
  const truncated = text.slice(0, 12000);
  const response = await getClient().messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1500,
    temperature: 0,
    system: `Sos un asistente especializado en extraer información administrativa de clases universitarias argentinas.
Analizá el texto y extraé SOLO información de tipo administrativo-evaluativo claramente mencionada.

Buscá:
1. Fechas de exámenes (parciales, finales, recuperatorios, coloquios)
2. Lineamientos de trabajos prácticos: nombre, consigna, fecha de entrega
3. Lineamientos generales: metodología, reglas de evaluación, porcentajes, condiciones de aprobación, regularidad
4. Avisos importantes: cambios de aula/horario, materiales, inscripciones

RESPONDÉ SOLO JSON (sin markdown):
{
  "exam_dates": [
    { "label": "1er Parcial", "date": "YYYY-MM-DD o null", "type": "parcial|final|recuperatorio", "notes": "..." }
  ],
  "lineamientos": [
    { "title": "título conciso", "content": "descripción", "type": "trabajo_practico|metodologia|evaluacion|aviso|general", "due_date": "YYYY-MM-DD o null" }
  ]
}

Si no hay información de este tipo, devolvé: {"exam_dates":[],"lineamientos":[]}`,
    messages: [{ role: 'user', content: `TEXTO DE LA CLASE:\n${truncated}` }],
  });
  const raw = response.content.find(b => b.type === 'text')?.text ?? '';
  return extractJson(raw);
}

async function persistExamDates(examDates, { subject, userId, documentId, noteId, pool }) {
  let inserted = 0;
  for (const item of examDates) {
    if (!item.label || !isValidDate(item.date)) continue;
    const validTypes = new Set(['parcial', 'final', 'recuperatorio']);
    const examType = validTypes.has(item.type) ? item.type : 'parcial';

    const { rows: existing } = await pool.query(
      'SELECT id FROM subject_exam_dates WHERE user_id = $1 AND subject = $2 AND exam_date = $3',
      [userId, subject, item.date]
    );
    if (existing.length) continue;

    await pool.query(
      `INSERT INTO subject_exam_dates (user_id, subject, label, exam_date, exam_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, subject, item.label, item.date, examType]
    );
    inserted++;
  }
  return inserted;
}

async function persistLineamientos(lineamientos, { subject, userId, documentId, noteId, pool }) {
  const validTypes = new Set(['general', 'trabajo_practico', 'metodologia', 'evaluacion', 'aviso']);
  let inserted = 0;
  for (const item of lineamientos) {
    if (!item.title?.trim()) continue;
    const type = validTypes.has(item.type) ? item.type : 'general';
    const dueDate = isValidDate(item.due_date) ? item.due_date : null;

    await pool.query(
      `INSERT INTO subject_lineamientos
         (user_id, subject, title, content, lineamiento_type, due_date, source_document_id, source_note_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, subject, item.title.trim(), item.content?.trim() ?? '', type, dueDate,
       documentId ?? null, noteId ?? null]
    );
    inserted++;
  }
  return inserted;
}

export async function extractAndPersistCourseMetadata(text, { subject, userId, documentId, noteId, pool }) {
  if (!text || text.length < 100) return;

  let status = 'completed';
  let extracted = null;
  let examDatesInserted = 0;
  let lineamientosInserted = 0;

  try {
    extracted = await callLLM(text);

    if (!extracted) {
      logger.warn('[courseMetadataExtractor] Could not parse LLM response', { subject, userId });
      status = 'failed';
    } else {
      const examDates = Array.isArray(extracted.exam_dates) ? extracted.exam_dates : [];
      const lineamientos = Array.isArray(extracted.lineamientos) ? extracted.lineamientos : [];

      if (!examDates.length && !lineamientos.length) {
        status = 'nothing_found';
      } else {
        [examDatesInserted, lineamientosInserted] = await Promise.all([
          persistExamDates(examDates, { subject, userId, documentId, noteId, pool }),
          persistLineamientos(lineamientos, { subject, userId, documentId, noteId, pool }),
        ]);

        logger.info('[courseMetadataExtractor] Metadata extracted and persisted', {
          subject, userId,
          examDatesFound: examDates.length, examDatesInserted,
          lineamientosFound: lineamientos.length, lineamientosInserted,
        });
      }

      await pool.query(
        `INSERT INTO course_metadata_extraction_log
           (user_id, subject, source_document_id, source_note_id,
            exam_dates_found, exam_dates_inserted,
            lineamientos_found, lineamientos_inserted,
            raw_extraction, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          userId, subject, documentId ?? null, noteId ?? null,
          Array.isArray(extracted?.exam_dates) ? extracted.exam_dates.length : 0,
          examDatesInserted,
          Array.isArray(extracted?.lineamientos) ? extracted.lineamientos.length : 0,
          lineamientosInserted,
          JSON.stringify(extracted),
          status,
        ]
      );
    }
  } catch (err) {
    logger.error('[courseMetadataExtractor] Extraction failed', { subject, userId, err: err.message });
    try {
      await pool.query(
        `INSERT INTO course_metadata_extraction_log
           (user_id, subject, source_document_id, source_note_id, raw_extraction, status)
         VALUES ($1,$2,$3,$4,$5,'failed')`,
        [userId, subject, documentId ?? null, noteId ?? null, JSON.stringify(extracted)]
      );
    } catch (_) {}
  }
}
