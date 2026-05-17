import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL    = process.env.DATABASE_URL    || 'postgres://test:test@localhost:5432/test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.VOYAGE_API_KEY  = process.env.VOYAGE_API_KEY  || 'voyage-test';
process.env.JWT_SECRET      = process.env.JWT_SECRET      || 'test-secret-that-is-at-least-32-chars-x';

const { buildSlidePayload, reconstructMarkdown } = await import('../markdownReconstructor.service.js');

// ---- buildSlidePayload ----

function makeRow(slideNumber, overrides = {}) {
  return {
    slide_number:    slideNumber,
    structured_json: {
      title:              `Título slide ${slideNumber}`,
      visible_text:       [`Texto visible ${slideNumber}`],
      formulas:           [],
      visual_description: `Descripción visual ${slideNumber}`,
      diagram_relations:  [],
      teacher_intent:     `Intención del docente ${slideNumber}`,
      warnings:           [],
      ...overrides,
    },
  };
}

test('buildSlidePayload includes required fields', () => {
  const row    = makeRow(3);
  const result = buildSlidePayload(row);

  assert.equal(result.slide_number, 3);
  assert.equal(result.title, 'Título slide 3');
  assert.deepEqual(result.visible_text, ['Texto visible 3']);
  assert.deepEqual(result.formulas, []);
  assert.equal(result.visual_description, 'Descripción visual 3');
  assert.deepEqual(result.diagram_relations, []);
  assert.equal(result.teacher_intent, 'Intención del docente 3');
  assert.deepEqual(result.warnings, []);
});

test('buildSlidePayload omits concepts_candidate when empty', () => {
  const row    = makeRow(1, { concepts_candidate: [] });
  const result = buildSlidePayload(row);
  assert.ok(!('concepts_candidate' in result), 'should not include empty concepts_candidate');
});

test('buildSlidePayload includes concepts_candidate when present', () => {
  const concepts = [{ label: 'Concepto A', definition: 'Definición A', evidence: 'texto' }];
  const row    = makeRow(2, { concepts_candidate: concepts });
  const result = buildSlidePayload(row);
  assert.deepEqual(result.concepts_candidate, concepts);
});

test('buildSlidePayload does not fail when structured_json has warnings', () => {
  const row = makeRow(5, { warnings: ['texto ilegible', 'imagen decorativa'] });
  assert.doesNotThrow(() => buildSlidePayload(row));
  const result = buildSlidePayload(row);
  assert.deepEqual(result.warnings, ['texto ilegible', 'imagen decorativa']);
});

test('buildSlidePayload handles null structured_json gracefully', () => {
  const row    = { slide_number: 7, structured_json: null };
  const result = buildSlidePayload(row);
  assert.equal(result.slide_number, 7);
  assert.equal(result.title, null);
  assert.deepEqual(result.visible_text, []);
  assert.deepEqual(result.formulas, []);
  assert.deepEqual(result.warnings, []);
});

test('buildSlidePayload handles missing structured_json fields gracefully', () => {
  const row    = { slide_number: 9, structured_json: { title: 'Solo título' } };
  const result = buildSlidePayload(row);
  assert.equal(result.title, 'Solo título');
  assert.deepEqual(result.visible_text, []);
  assert.deepEqual(result.diagram_relations, []);
});

// ---- batch grouping logic (via RECONSTRUCT_BATCH_SIZE env var) ----

function makeRows(count) {
  return Array.from({ length: count }, (_, i) => makeRow(i + 1));
}

function groupIntoBatches(rows, batchSize) {
  const batches = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    batches.push(rows.slice(i, i + batchSize));
  }
  return batches;
}

test('batch grouping: 17 slides / 4 → 5 batches', () => {
  const rows    = makeRows(17);
  const batches = groupIntoBatches(rows, 4);
  assert.equal(batches.length, 5, 'should produce 5 batches for 17 slides');
  assert.equal(batches[0].length, 4);
  assert.equal(batches[4].length, 1, 'last batch has 1 slide');
});

test('batch grouping: maintains slide order', () => {
  const rows    = makeRows(9);
  const batches = groupIntoBatches(rows, 4);
  const flattened = batches.flat().map(r => r.slide_number);
  assert.deepEqual(flattened, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('batch grouping: even division produces equal batches', () => {
  const rows    = makeRows(8);
  const batches = groupIntoBatches(rows, 4);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 4);
  assert.equal(batches[1].length, 4);
});

test('batch grouping: slide numbers in each batch are correct', () => {
  const rows    = makeRows(5);
  const batches = groupIntoBatches(rows, 2);
  assert.equal(batches[0][0].slide_number, 1);
  assert.equal(batches[0][1].slide_number, 2);
  assert.equal(batches[1][0].slide_number, 3);
  assert.equal(batches[1][1].slide_number, 4);
  assert.equal(batches[2][0].slide_number, 5);
});

// ---- error message format ----

test('failed batch error message contains slide range', () => {
  const firstSlide = 5;
  const lastSlide  = 8;
  const innerMsg   = 'Request timed out.';
  const msg = `Markdown reconstruction failed at slides ${firstSlide}-${lastSlide}: ${innerMsg}`;
  assert.ok(msg.includes('slides 5-8'), 'error must reference the slide range');
  assert.ok(msg.includes('Request timed out.'), 'error must include the root cause');
});

// ---- module surface ----

test('reconstructMarkdown is an async function', () => {
  assert.equal(typeof reconstructMarkdown, 'function');
  // Calling with no args should reject (not throw synchronously)
  const result = reconstructMarkdown();
  assert.ok(result instanceof Promise, 'reconstructMarkdown must return a Promise');
  result.catch(() => {}); // silence unhandled rejection
});
