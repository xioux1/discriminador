import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set env vars before the dynamic import so the service module initialises cleanly
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-x';

const {
  chunkText,
  safeJsonParseArray,
  validateConcept,
  cosineSimilarity,
  deduplicateConcepts,
  normalizeText,
} = await import('../conceptExtractor.service.js');

// ---- chunkText ----

test('chunkText produces correct overlap between consecutive chunks', () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
  const text = words.join(' ');
  const chunks = chunkText(text, 300, 50);

  assert.ok(chunks.length >= 2, 'should produce at least 2 chunks for 400 words');

  // Last 50 words of chunk 0 should equal first 50 words of chunk 1
  const chunk0Words = chunks[0].text.split(' ');
  const chunk1Words = chunks[1].text.split(' ');
  const tail = chunk0Words.slice(-50);
  const head = chunk1Words.slice(0, 50);
  assert.deepEqual(tail, head, 'overlap region must match');
});

test('chunkText assigns sequential index values', () => {
  const text = Array.from({ length: 700 }, (_, i) => `w${i}`).join(' ');
  const chunks = chunkText(text, 300, 50);

  for (let i = 0; i < chunks.length; i++) {
    assert.equal(chunks[i].index, i);
  }
});

test('chunkText handles text shorter than windowSize', () => {
  const text = 'one two three four five';
  const chunks = chunkText(text, 300, 50);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, text);
});

// ---- safeJsonParseArray ----

test('safeJsonParseArray parses clean JSON array', () => {
  const raw = '[{"label": "Prescripción en contrato de seguro", "definition": "Cubre el plazo.", "evidence": "plazo de un año"}]';
  const result = safeJsonParseArray(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].label, 'Prescripción en contrato de seguro');
});

test('safeJsonParseArray recovers JSON array surrounded by extra text', () => {
  const raw = 'Here is the result:\n[{"label": "Test label here ok", "definition": "Some definition text here.", "evidence": "text"}]\nEnd.';
  const result = safeJsonParseArray(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].label, 'Test label here ok');
});

test('safeJsonParseArray returns empty array for invalid JSON', () => {
  const result = safeJsonParseArray('this is not json at all');
  assert.deepEqual(result, []);
});

test('safeJsonParseArray returns empty array for null input', () => {
  assert.deepEqual(safeJsonParseArray(null), []);
  assert.deepEqual(safeJsonParseArray(''), []);
  assert.deepEqual(safeJsonParseArray(undefined), []);
});

test('safeJsonParseArray returns empty array when parsed value is not an array', () => {
  const result = safeJsonParseArray('{"label": "something"}');
  assert.deepEqual(result, []);
});

// ---- validateConcept ----

test('validateConcept rejects label with only one word', () => {
  const concept = {
    label: 'Seguro',
    definition: 'Cubre aspectos generales de los contratos de seguro y sus partes involucradas.',
    evidence: 'contrato de seguro',
  };
  assert.equal(validateConcept(concept, 'chunk text', 0), null);
});

test('validateConcept rejects exact generic label "Conceptos básicos"', () => {
  const concept = {
    label: 'Conceptos básicos',
    definition: 'Cubre los conceptos básicos y fundamentales de la materia según el programa.',
    evidence: 'conceptos básicos',
  };
  assert.equal(validateConcept(concept, 'chunk text', 0), null);
});

test('validateConcept rejects label with more than 8 words', () => {
  const concept = {
    label: 'Este es un label que tiene demasiadas palabras aquí',
    definition: 'Definición suficientemente larga para pasar la validación de palabras mínimas.',
    evidence: 'algún texto del fragmento original',
  };
  assert.equal(validateConcept(concept, 'chunk text', 0), null);
});

test('validateConcept accepts label with 4 to 8 words', () => {
  const concept = {
    label: 'Prescripción en contrato de seguro',
    definition: 'Cubre el plazo y el momento desde el cual se computa la prescripción.',
    evidence: 'plazo de prescripción',
  };
  const result = validateConcept(concept, 'some chunk text here', 2);
  assert.ok(result !== null, 'should accept valid concept');
  assert.equal(result.label, 'Prescripción en contrato de seguro');
  assert.equal(result.source_chunk_index, 2);
});

test('validateConcept rejects label with fewer than 4 words', () => {
  const concept = {
    label: 'Prescripción seguro',
    definition: 'Cubre el plazo y el momento desde el cual se computa la prescripción de acciones.',
    evidence: 'text',
  };
  assert.equal(validateConcept(concept, 'chunk', 0), null);
});

test('validateConcept rejects definition with fewer than 8 words', () => {
  const concept = {
    label: 'Prescripción en contrato de seguro',
    definition: 'Muy corto.',
    evidence: 'text',
  };
  assert.equal(validateConcept(concept, 'chunk', 0), null);
});

test('validateConcept sets evidence to null when missing', () => {
  const concept = {
    label: 'Titularidad de invenciones laborales creadas',
    definition: 'Regula quién posee los derechos sobre invenciones generadas por un empleado durante la relación laboral.',
  };
  const result = validateConcept(concept, 'chunk', 0);
  assert.ok(result !== null);
  assert.equal(result.evidence, null);
});

test('validateConcept adds trailing period to definition if missing', () => {
  const concept = {
    label: 'Medición de estados cuánticos en física',
    definition: 'Cubre los métodos para medir el estado de un sistema cuántico sin colapso previo',
    evidence: 'colapso de la función de onda',
  };
  const result = validateConcept(concept, 'chunk', 0);
  assert.ok(result !== null);
  assert.ok(result.definition.endsWith('.'));
});

// ---- cosineSimilarity ----

test('cosineSimilarity returns 1 for identical vectors', () => {
  const v = [0.1, 0.2, 0.3, 0.4];
  const sim = cosineSimilarity(v, v);
  assert.ok(Math.abs(sim - 1) < 1e-9, `expected ~1, got ${sim}`);
});

test('cosineSimilarity returns 0 for orthogonal vectors', () => {
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  const sim = cosineSimilarity(a, b);
  assert.ok(Math.abs(sim) < 1e-9, `expected ~0, got ${sim}`);
});

test('cosineSimilarity returns value between -1 and 1', () => {
  const a = [0.3, -0.1, 0.7, 0.2];
  const b = [0.1, 0.5, -0.3, 0.8];
  const sim = cosineSimilarity(a, b);
  assert.ok(sim >= -1 && sim <= 1, `out of range: ${sim}`);
});

test('cosineSimilarity returns 0 for mismatched lengths', () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});

// ---- deduplicateConcepts ----

function makeVec(primary, secondary = 0) {
  // 4-dim unit-like vector with a dominant dimension
  const v = [0, 0, 0, 0];
  v[primary] = 0.9;
  v[secondary] = 0.1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

function makeConcept(label, primary, secondary = 0) {
  return {
    label,
    definition: `Definición detallada sobre ${label} con suficientes palabras para validar.`,
    evidence: 'fragmento del texto original',
    source_chunk: 'chunk',
    source_chunk_index: 0,
    embedding: makeVec(primary, secondary),
  };
}

test('deduplicateConcepts merges concepts above threshold', () => {
  const a = makeConcept('Prescripción en contrato de seguro', 0);
  const b = makeConcept('Prescripción del contrato de seguro vigente', 0); // same dominant dim → very similar
  const result = deduplicateConcepts([a, b], 0.86);
  assert.equal(result.length, 1, 'should merge near-duplicate concepts');
});

test('deduplicateConcepts keeps distinct concepts separate', () => {
  const a = makeConcept('Prescripción en contrato de seguro', 0);
  const b = makeConcept('Complemento resultativo en chino mandarín', 1);
  const c = makeConcept('Procedimientos almacenados en PL SQL', 2);
  const result = deduplicateConcepts([a, b, c], 0.86);
  assert.equal(result.length, 3, 'distinct concepts must not be merged');
});

test('deduplicateConcepts uses configurable threshold', () => {
  const a = makeConcept('Titularidad de invenciones laborales creadas', 0);
  // Slightly different but still same primary dim
  const bVec = makeVec(0, 1).map((x, i) => (i === 0 ? x * 0.95 : x));
  const b = {
    label: 'Titularidad de invenciones en relación laboral',
    definition: 'Descripción detallada de la titularidad de invenciones en contexto laboral específico.',
    evidence: null,
    source_chunk: 'chunk',
    source_chunk_index: 1,
    embedding: bVec,
  };

  // With low threshold, they merge
  const merged = deduplicateConcepts([a, b], 0.5);
  assert.equal(merged.length, 1);

  // With threshold of 1.0 (exact match only), they don't merge
  const notMerged = deduplicateConcepts([a, b], 1.0);
  assert.equal(notMerged.length, 2);
});

// ---- normalizeText ----

test('normalizeText collapses whitespace and trims', () => {
  const result = normalizeText('  hello   world\n\ntest  ');
  assert.equal(result, 'hello world test');
});

test('normalizeText handles null/undefined gracefully', () => {
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
});
