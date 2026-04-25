import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-x';

const {
  safeJsonParseObject,
  getDefaultMaxVariantsForCluster,
  validateGeneratedCardDraft,
} = await import('../cardGeneration.service.js');

// ---- Shared test data ----

const CONCEPT_A = {
  id: '11111111-1111-1111-1111-111111111111',
  label: 'ERP fundamentos',
  definition: 'Sistema empresarial integrado que conecta procesos de negocio.',
  evidence: null,
  source_chunk: null,
  source_chunk_index: 3,
};

const CONCEPT_B = {
  id: '22222222-2222-2222-2222-222222222222',
  label: 'Módulos ERP',
  definition: 'Componentes funcionales del ERP como ventas, finanzas, RRHH.',
  evidence: null,
  source_chunk: null,
  source_chunk_index: 4,
};

const CONTEXT = {
  cluster: { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'ERP Fundamentos', definition: 'Sistemas ERP y su arquitectura.' },
  document: { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', title: 'Sistemas de Información.pdf', subject_name: 'Sistemas de Información' },
  concepts: [CONCEPT_A, CONCEPT_B],
  source_excerpts: [
    { chunk_index: 3, text: 'El ERP integra distintas áreas funcionales de la organización.' },
    { chunk_index: 4, text: 'Los módulos del ERP cubren ventas, finanzas, producción y RRHH.' },
  ],
};

const VALID_VARIANT = {
  question: '¿Qué es un ERP y qué problema busca resolver dentro de una organización?',
  expected_answer: 'Un ERP es un sistema empresarial interfuncional compuesto por módulos integrados que dan soporte a los procesos internos básicos de una organización. Su objetivo principal es integrar la información de distintas áreas funcionales, como ventas, finanzas, recursos humanos y producción, evitando la dispersión de datos y la falta de coordinación entre departamentos. Funciona como una columna vertebral que automatiza y estandariza los procesos internos, facilitando la toma de decisiones basada en información actualizada y consistente.',
  grading_rubric: [
    'Menciona que el ERP es un sistema interfuncional.',
    'Menciona integración de módulos o áreas.',
    'Explica que resuelve la dispersión de datos o silos de información.',
    'Relaciona el ERP con la automatización de procesos internos.',
  ],
  source_concept_ids: [CONCEPT_A.id],
  source_chunk_indexes: [3],
  difficulty: 'medium',
  answer_time_seconds: 50,
};

const VALID_OUTPUT = {
  card_group: {
    title: 'Fundamentos y arquitectura de los sistemas ERP',
    card_type: 'theoretical_open',
  },
  variants: [VALID_VARIANT],
};

// ==================== safeJsonParseObject ====================

test('safeJsonParseObject parses clean JSON object', () => {
  const raw = '{"card_group": {"title": "Test", "card_type": "theoretical_open"}, "variants": []}';
  const result = safeJsonParseObject(raw);
  assert.ok(result !== null);
  assert.equal(result.card_group.title, 'Test');
});

test('safeJsonParseObject recovers JSON object surrounded by extra text', () => {
  const raw = 'Here is the result:\n{"card_group": {"title": "Test", "card_type": "theoretical_open"}, "variants": []}\nEnd.';
  const result = safeJsonParseObject(raw);
  assert.ok(result !== null);
  assert.equal(result.card_group.title, 'Test');
});

test('safeJsonParseObject returns null for non-object JSON', () => {
  assert.equal(safeJsonParseObject('[1, 2, 3]'), null);
  assert.equal(safeJsonParseObject('"just a string"'), null);
});

test('safeJsonParseObject returns null for invalid JSON', () => {
  assert.equal(safeJsonParseObject('this is not json'), null);
  assert.equal(safeJsonParseObject(null), null);
  assert.equal(safeJsonParseObject(''), null);
  assert.equal(safeJsonParseObject(undefined), null);
});

// ==================== getDefaultMaxVariantsForCluster ====================

test('getDefaultMaxVariantsForCluster returns 5 for tier A', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: 'A' }), 5);
});

test('getDefaultMaxVariantsForCluster returns 3 for tier B', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: 'B' }), 3);
});

test('getDefaultMaxVariantsForCluster returns 2 for tier C', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: 'C' }), 2);
});

test('getDefaultMaxVariantsForCluster returns 1 for tier D', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: 'D' }), 1);
});

test('getDefaultMaxVariantsForCluster returns 5 for null tier', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: null }), 5);
  assert.equal(getDefaultMaxVariantsForCluster({}), 5);
  assert.equal(getDefaultMaxVariantsForCluster(null), 5);
});

test('getDefaultMaxVariantsForCluster falls back to priority_tier when relative_priority_tier is null', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: null, priority_tier: 'B' }), 3);
});

// ==================== validateGeneratedCardDraft ====================

test('validateGeneratedCardDraft accepts valid output', () => {
  const result = validateGeneratedCardDraft(VALID_OUTPUT, CONTEXT, 5);
  assert.equal(result.valid, true);
  assert.equal(result.validVariants.length, 1);
  assert.deepEqual(result.errors, []);
});

test('validateGeneratedCardDraft rejects card_group without title', () => {
  const output = {
    card_group: { title: '', card_type: 'theoretical_open' },
    variants: [VALID_VARIANT],
  };
  const result = validateGeneratedCardDraft(output, CONTEXT, 5);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('title')));
});

test('validateGeneratedCardDraft rejects card_group with wrong card_type', () => {
  const output = {
    card_group: { title: 'Fundamentos ERP arquitectura', card_type: 'multiple_choice' },
    variants: [VALID_VARIANT],
  };
  const result = validateGeneratedCardDraft(output, CONTEXT, 5);
  assert.equal(result.valid, false);
});

test('validateGeneratedCardDraft rejects when variants exceed maxVariants', () => {
  const output = {
    card_group: { title: 'Fundamentos ERP arquitectura', card_type: 'theoretical_open' },
    variants: [
      VALID_VARIANT,
      { ...VALID_VARIANT, question: '¿Por qué el ERP se considera columna vertebral interfuncional?' },
      { ...VALID_VARIANT, question: '¿Qué significa que un ERP tenga estructura modular integrada?' },
    ],
  };
  // maxVariants = 1, but 3 provided — should trim and validate 1
  const result = validateGeneratedCardDraft(output, CONTEXT, 1);
  assert.ok(result.validVariants.length <= 1);
});

test('validateGeneratedCardDraft rejects source_concept_ids with unknown IDs', () => {
  const output = {
    card_group: { title: 'Fundamentos ERP arquitectura', card_type: 'theoretical_open' },
    variants: [{
      ...VALID_VARIANT,
      source_concept_ids: ['00000000-0000-0000-0000-000000000000'],
    }],
  };
  const result = validateGeneratedCardDraft(output, CONTEXT, 5);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('unknown IDs') || e.includes('No valid variants')));
});

test('validateGeneratedCardDraft rejects invalid difficulty value', () => {
  const output = {
    card_group: { title: 'Fundamentos ERP arquitectura', card_type: 'theoretical_open' },
    variants: [{ ...VALID_VARIANT, difficulty: 'extreme' }],
  };
  const result = validateGeneratedCardDraft(output, CONTEXT, 5);
  assert.equal(result.valid, false);
});

test('validateGeneratedCardDraft rejects grading_rubric with fewer than 3 items', () => {
  const output = {
    card_group: { title: 'Fundamentos ERP arquitectura', card_type: 'theoretical_open' },
    variants: [{
      ...VALID_VARIANT,
      grading_rubric: ['Solo un criterio.', 'Solo dos criterios.'],
    }],
  };
  const result = validateGeneratedCardDraft(output, CONTEXT, 5);
  assert.equal(result.valid, false);
});

test('validateGeneratedCardDraft discards invalid variant and keeps valid ones', () => {
  const goodVariant = VALID_VARIANT;
  const badVariant = {
    ...VALID_VARIANT,
    question: '¿Cuáles son los módulos funcionales del ERP dentro de la organización?',
    difficulty: 'extreme', // invalid
  };
  const output = {
    card_group: { title: 'Fundamentos ERP arquitectura', card_type: 'theoretical_open' },
    variants: [goodVariant, badVariant],
  };
  const result = validateGeneratedCardDraft(output, CONTEXT, 5);
  // Should keep the good one and discard the bad one
  assert.equal(result.valid, true);
  assert.equal(result.validVariants.length, 1);
  assert.equal(result.validVariants[0].question, goodVariant.question);
});
