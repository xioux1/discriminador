import Anthropic from '@anthropic-ai/sdk';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = process.env.LLM_TRANSCRIPT_MODEL || 'claude-sonnet-4-6';
const WORDS_PER_CHUNK = 3000;
const OVERLAP_WORDS = 200;

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

// Splits text into overlapping chunks by paragraph boundaries.
export function chunkTranscript(text, wordsPerChunk = WORDS_PER_CHUNK, overlapWords = OVERLAP_WORDS) {
  const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());
  const chunks = [];
  let current = [];
  let wordCount = 0;

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).length;
    if (wordCount + paraWords > wordsPerChunk && current.length) {
      chunks.push(current.join('\n\n'));
      // Keep last paragraphs for overlap
      let overlapCount = 0;
      const overlapParas = [];
      for (let i = current.length - 1; i >= 0 && overlapCount < overlapWords; i--) {
        const w = current[i].split(/\s+/).length;
        overlapParas.unshift(current[i]);
        overlapCount += w;
      }
      current = overlapParas;
      wordCount = overlapCount;
    }
    current.push(para);
    wordCount += paraWords;
  }
  if (current.length) chunks.push(current.join('\n\n'));
  return chunks.length ? chunks : [text];
}

async function extractConceptsFromChunk(chunkText, subject) {
  const response = await getClient().messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1200,
    temperature: 0,
    system: `Sos un extractor de conceptos académicos de una clase universitaria.
Analizá el fragmento de clase y extraé TODOS los conceptos o temas mencionados.
Para cada concepto incluí:
- name: nombre conciso del concepto
- key_points: array de 2-4 puntos clave explicados en el fragmento
- mentions: número aproximado de veces que se habló de este tema
- emphasis_phrases: frases textuales donde el profesor enfatizó importancia (palabras como "importante", "siempre cae", "en el parcial", "fundamental", "siempre", "nunca olviden"). Array vacío si no hay.

RESPONDÉ SOLO JSON:
{"concepts": [{"name": "...", "key_points": [...], "mentions": N, "emphasis_phrases": [...]}]}`,
    messages: [{ role: 'user', content: `Materia: ${subject}\n\nFRAGMENTO DE CLASE:\n${chunkText}` }],
  });
  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  const result = extractJson(text);
  return result?.concepts || [];
}

function crossReferenceWithExams(clusters, examTexts, syllabusText) {
  const combined = (examTexts.join(' ') + ' ' + (syllabusText || '')).toLowerCase();
  for (const cluster of clusters) {
    const name = cluster.concept.toLowerCase();
    // Count approximate hits in exam material
    const examHits = (combined.match(new RegExp(name.split(' ')[0], 'gi')) || []).length;
    if (examHits >= 3) cluster.importance = Math.min(5, cluster.importance + 2);
    else if (examHits >= 1) cluster.importance = Math.min(5, cluster.importance + 1);
    cluster.exam_relevance = examHits >= 3 ? 'high' : examHits >= 1 ? 'medium' : 'low';
  }
}

async function mergeAndWeightConcepts(chunkedResults, subject, examContext) {
  const allConcepts = chunkedResults.flat();
  if (!allConcepts.length) return null;

  const conceptsSummary = JSON.stringify(allConcepts).slice(0, 30000);

  const response = await getClient().messages.create({
    model: SONNET_MODEL,
    max_tokens: 4000,
    temperature: 0,
    system: `Sos un sintetizador académico. Recibís conceptos extraídos de múltiples fragmentos de una misma clase universitaria.
Tu tarea:
1. Consolidar conceptos duplicados o muy similares en uno solo
2. Unificar los key_points en un resumen coherente
3. Sumar las menciones de duplicados
4. Unificar las emphasis_phrases
5. Asignar importancia 1-5:
   - 1: mencionado de pasada
   - 2: explicado brevemente
   - 3: tema central de la clase
   - 4: con énfasis evaluativo ("cae en el parcial", etc.)
   - 5: crítico, muy enfatizado

Materia: ${subject}
${examContext ? `Contexto de exámenes previos: ${examContext.slice(0, 2000)}` : ''}

RESPONDÉ SOLO JSON con este schema exacto:
{
  "clusters": [
    {
      "concept": "nombre del concepto",
      "importance": 3,
      "importance_reason": "breve justificación",
      "mentions": 4,
      "summary": "resumen de 2-4 oraciones del concepto",
      "key_points": ["punto 1", "punto 2"],
      "professor_emphasis": ["frase textual si la hay"]
    }
  ],
  "professor_emphasis": ["hasta 5 frases textuales del profesor más importantes de toda la clase"],
  "raw_summary": "párrafo resumen de la clase completa en 3-5 oraciones"
}`,
    messages: [{ role: 'user', content: `CONCEPTOS EXTRAÍDOS DE LOS FRAGMENTOS:\n${conceptsSummary}` }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  return extractJson(text);
}

export async function processTranscript({ noteId, transcriptText, subject, pool, userId }) {
  // Mark as processing
  await pool.query(
    'UPDATE subject_class_notes SET processing_status = $1, updated_at = now() WHERE id = $2 AND user_id = $3',
    ['processing', noteId, userId]
  );

  try {
    // Fetch exam and syllabus context for importance cross-reference
    const [examsResult, configResult] = await Promise.all([
      pool.query('SELECT content_text FROM reference_exams WHERE subject = $1 AND user_id = $2 LIMIT 5', [subject, userId]),
      pool.query('SELECT syllabus_text FROM subject_configs WHERE subject = $1 AND user_id = $2', [subject, userId]),
    ]);
    const examTexts = examsResult.rows.map(r => r.content_text || '');
    const syllabusText = configResult.rows[0]?.syllabus_text || '';

    // Pass 1: chunk + extract per chunk (parallel, Haiku)
    const chunks = chunkTranscript(transcriptText);
    const chunkedResults = await Promise.all(
      chunks.map(chunk => extractConceptsFromChunk(chunk, subject))
    );

    // Pass 2: merge + weight (Sonnet)
    const examContext = examTexts.slice(0, 3).join('\n---\n');
    const merged = await mergeAndWeightConcepts(chunkedResults, subject, examContext);

    if (!merged) {
      await pool.query(
        'UPDATE subject_class_notes SET processing_status = $1, updated_at = now() WHERE id = $2 AND user_id = $3',
        ['error', noteId, userId]
      );
      return;
    }

    // Cross-reference importance with exam material (pure JS, no LLM)
    if (merged.clusters) {
      crossReferenceWithExams(merged.clusters, examTexts, syllabusText);
      // Sort by importance desc
      merged.clusters.sort((a, b) => b.importance - a.importance);
    }

    const structured = {
      processed_at: new Date().toISOString(),
      ...merged,
    };

    await pool.query(
      `UPDATE subject_class_notes
       SET structured_data = $1, processing_status = 'done', content = COALESCE(NULLIF(content, ''), $2), updated_at = now()
       WHERE id = $3 AND user_id = $4`,
      [JSON.stringify(structured), merged.raw_summary || '', noteId, userId]
    );

    return structured;
  } catch (err) {
    console.error('processTranscript error', err.message);
    await pool.query(
      'UPDATE subject_class_notes SET processing_status = $1, updated_at = now() WHERE id = $2 AND user_id = $3',
      ['error', noteId, userId]
    );
  }
}
