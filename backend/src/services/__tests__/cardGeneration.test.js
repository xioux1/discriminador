import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-x';

const {
  safeJsonParseObject,
  getDefaultMaxVariantsForCluster,
  validateGeneratedCardDraft,
  detectEnumerativeCluster,
  detectPhaseCluster,
  buildCardGenerationPrompt,
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
  expected_answer: `- ERP integra procesos clave de ventas, finanzas, RRHH y operaciones.
- Centraliza datos para evitar silos entre áreas y tareas duplicadas.
- Estandariza flujos internos y mejora control operativo diario.
- Aumenta trazabilidad para decidir con información consistente y actualizada.`,
  grading_rubric: [
    'Menciona que el ERP es un sistema interfuncional.',
    'Menciona integración de módulos o áreas.',
    'Explica que resuelve la dispersión de datos o silos de información.',
    'Relaciona el ERP con la automatización de procesos internos.',
  ],
  source_concept_ids: [CONCEPT_A.id, CONCEPT_B.id],
  source_chunk_indexes: [3, 4],
  tag_labels: ['erp_fundamentos', 'integracion_modular'],
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

test('getDefaultMaxVariantsForCluster returns 9 for tier A', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: 'A' }), 9);
});

test('getDefaultMaxVariantsForCluster returns 7 for tier B', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: 'B' }), 7);
});

test('getDefaultMaxVariantsForCluster returns 5 for tier C', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: 'C' }), 5);
});

test('getDefaultMaxVariantsForCluster returns 3 for tier D', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: 'D' }), 3);
});

test('getDefaultMaxVariantsForCluster returns 9 for null tier', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: null }), 9);
  assert.equal(getDefaultMaxVariantsForCluster({}), 9);
  assert.equal(getDefaultMaxVariantsForCluster(null), 9);
});

test('getDefaultMaxVariantsForCluster falls back to priority_tier when relative_priority_tier is null', () => {
  assert.equal(getDefaultMaxVariantsForCluster({ relative_priority_tier: null, priority_tier: 'B' }), 7);
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

test('validateGeneratedCardDraft accepts practical_exercise card_type', () => {
  const output = {
    card_group: { title: 'Fundamentos ERP arquitectura', card_type: 'practical_exercise' },
    variants: [VALID_VARIANT],
  };
  const result = validateGeneratedCardDraft(output, CONTEXT, 5);
  assert.equal(result.valid, true);
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

test('validateGeneratedCardDraft rejects expected_answer without bullet structure', () => {
  const output = {
    card_group: { title: 'Fundamentos ERP arquitectura', card_type: 'theoretical_open' },
    variants: [{
      ...VALID_VARIANT,
      expected_answer: 'Respuesta corrida sin bullets para probar la validación de densidad y formato.',
    }],
  };
  const result = validateGeneratedCardDraft(output, CONTEXT, 5);
  assert.equal(result.valid, false);
});

test('validateGeneratedCardDraft rejects variant without tag_labels', () => {
  const output = {
    card_group: { title: 'Fundamentos ERP arquitectura', card_type: 'theoretical_open' },
    variants: [{
      ...VALID_VARIANT,
      tag_labels: [],
    }],
  };
  const result = validateGeneratedCardDraft(output, CONTEXT, 5);
  assert.equal(result.valid, false);
});

test('validateGeneratedCardDraft rejects low concept coverage across variants', () => {
  const output = {
    card_group: { title: 'Fundamentos ERP arquitectura', card_type: 'theoretical_open' },
    variants: [
      { ...VALID_VARIANT, source_concept_ids: [CONCEPT_A.id] },
    ],
  };
  const result = validateGeneratedCardDraft(output, CONTEXT, 5);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('Concept coverage too low')));
});

test('validateGeneratedCardDraft discards invalid variant and keeps valid ones', () => {
  const goodVariant = { ...VALID_VARIANT, source_concept_ids: [CONCEPT_A.id, CONCEPT_B.id], source_chunk_indexes: [3, 4] };
  const badVariant = {
    ...VALID_VARIANT,
    question: '¿Cuáles son los módulos funcionales del ERP dentro de la organización?',
    difficulty: 'extreme', // invalid
    source_concept_ids: [CONCEPT_B.id],
    source_chunk_indexes: [4],
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

// ==================== detectEnumerativeCluster ====================

const ASAP_CONTEXT = {
  cluster: {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    name: 'Metodología ASAP para implementar SIG',
    definition: 'Conjunto de fases secuenciales para implementar un sistema ERP.',
  },
  concepts: [
    { label: 'Fases de la metodología ASAP', definition: 'Etapas del proceso de implementación: preparación, blueprint, realización.' },
    { label: 'Business Blueprint', definition: 'Fase de análisis y documentación de procesos de negocio.' },
  ],
  source_excerpts: [],
};

const NON_ENUM_CONTEXT = {
  cluster: {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    name: 'Transformada inversa de Laplace',
    definition: 'Operación que recupera una función del tiempo a partir de su transformada.',
  },
  concepts: [
    { label: 'Función de transferencia', definition: 'Cociente de transformadas de Laplace de salida sobre entrada.' },
    { label: 'Polo del sistema', definition: 'Valor de s que anula el denominador de la función de transferencia.' },
  ],
  source_excerpts: [],
};

test('detectEnumerativeCluster returns true for ASAP methodology cluster', () => {
  assert.equal(detectEnumerativeCluster(ASAP_CONTEXT), true);
});

test('detectEnumerativeCluster returns true when signal is in concept label', () => {
  const ctx = {
    cluster: { name: 'Gestión de proyectos de software', definition: 'Concepto genérico.' },
    concepts: [{ label: 'Entregables del sprint', definition: 'Documentos producidos al final de cada iteración.' }],
    source_excerpts: [],
  };
  assert.equal(detectEnumerativeCluster(ctx), true);
});

test('detectEnumerativeCluster returns false for non-enumerative cluster', () => {
  assert.equal(detectEnumerativeCluster(NON_ENUM_CONTEXT), false);
});

test('detectEnumerativeCluster returns false for empty context', () => {
  assert.equal(detectEnumerativeCluster({ cluster: { name: '', definition: '' }, concepts: [] }), false);
});

// ==================== buildCardGenerationPrompt — enumerative signals ====================

test('buildCardGenerationPrompt includes enumeration rule for enumerative cluster', () => {
  const prompt = buildCardGenerationPrompt(ASAP_CONTEXT, { maxVariants: 7 });
  assert.ok(prompt.includes('enumeración estructural'), 'prompt must include "enumeración estructural"');
  assert.ok(prompt.includes('Cuáles son'), 'prompt must include enumeration question example');
  assert.ok(prompt.includes('22-enum'), 'prompt must include rule 22-enum');
});

test('buildCardGenerationPrompt does not include enumeration rule for non-enumerative cluster', () => {
  const prompt = buildCardGenerationPrompt(NON_ENUM_CONTEXT, { maxVariants: 7 });
  assert.ok(!prompt.includes('22-enum'), 'prompt must not include rule 22-enum for non-enumerative cluster');
});

test('buildCardGenerationPrompt rule 11 contains enumeration exception', () => {
  const prompt = buildCardGenerationPrompt(ASAP_CONTEXT, { maxVariants: 7 });
  assert.ok(prompt.includes('EXCEPCIÓN — enumeración estructural'), 'rule 11 must mention enumeration exception');
});

// ==================== validateGeneratedCardDraft — 8-bullet limit ====================

function makeBullets(n, text = 'Fase del proceso de implementación') {
  return Array.from({ length: n }, (_, i) => `- ${text} ${i + 1}`).join('\n');
}

test('validateGeneratedCardDraft accepts 6 bullets in expected_answer', () => {
  const v = { ...VALID_VARIANT, expected_answer: makeBullets(6) };
  const output = { card_group: VALID_OUTPUT.card_group, variants: [v] };
  const result = validateGeneratedCardDraft(output, CONTEXT, 9);
  assert.ok(result.validVariants.length > 0 || result.valid, '6 bullets should be accepted');
});

test('validateGeneratedCardDraft accepts 8 bullets in expected_answer', () => {
  const v = { ...VALID_VARIANT, expected_answer: makeBullets(8) };
  const output = { card_group: VALID_OUTPUT.card_group, variants: [v] };
  const result = validateGeneratedCardDraft(output, CONTEXT, 9);
  assert.ok(result.validVariants.length > 0 || result.valid, '8 bullets should be accepted');
});

test('validateGeneratedCardDraft trims to 8 bullets (not 5) when 9 are provided', () => {
  const v = { ...VALID_VARIANT, expected_answer: makeBullets(9) };
  const output = { card_group: VALID_OUTPUT.card_group, variants: [v] };
  validateGeneratedCardDraft(output, CONTEXT, 9);
  const remaining = output.variants[0].expected_answer
    .split('\n')
    .filter(l => /^[-*•]\s+/.test(l));
  assert.equal(remaining.length, 8, 'should trim to 8, not 5');
});

// ==================== detectPhaseCluster ====================

const ASAP_PHASE_CONTEXT = {
  cluster: {
    id: 'pppppppp-pppp-pppp-pppp-pppppppppppp',
    name: 'Metodología ASAP para implementar SIG',
    definition: 'Conjunto de fases secuenciales para implementar un ERP.',
  },
  concepts: [
    { label: 'Fases de la metodología ASAP', definition: 'Preparación, Business Blueprint, Realización, Preparación final, GoLive.' },
    { label: 'Business Blueprint', definition: 'Fase de análisis y documentación de procesos de negocio.' },
  ],
  source_excerpts: [],
};

const ENUM_ONLY_CONTEXT = {
  cluster: {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    name: 'Opciones de implementación de SIG',
    definition: 'Distintas opciones para implementar un SIG según alcance.',
  },
  concepts: [
    { label: 'Implementación Big Bang', definition: 'Opción que implanta todos los módulos simultáneamente.' },
    { label: 'Implementación incremental', definition: 'Opción que implanta módulos por etapas.' },
  ],
  source_excerpts: [],
};

test('detectPhaseCluster returns true for ASAP methodology cluster', () => {
  assert.equal(detectPhaseCluster(ASAP_PHASE_CONTEXT), true);
});

test('detectPhaseCluster returns true when cluster name contains "fases"', () => {
  const ctx = {
    cluster: { name: 'Fases del ciclo de vida del proyecto', definition: 'Etapas principales del proyecto.' },
    concepts: [],
    source_excerpts: [],
  };
  assert.equal(detectPhaseCluster(ctx), true);
});

test('detectPhaseCluster returns true when concept label contains "Business Blueprint"', () => {
  const ctx = {
    cluster: { name: 'Implementación ERP', definition: 'Proceso de implementación.' },
    concepts: [{ label: 'Business Blueprint', definition: 'Análisis de procesos.' }],
    source_excerpts: [],
  };
  assert.equal(detectPhaseCluster(ctx), true);
});

test('detectPhaseCluster returns true when concept label contains "GoLive"', () => {
  const ctx = {
    cluster: { name: 'Puesta en marcha del sistema', definition: 'Último paso de la implementación.' },
    concepts: [{ label: 'GoLive y soporte post-implementación', definition: 'Inicio de operaciones productivas.' }],
    source_excerpts: [],
  };
  assert.equal(detectPhaseCluster(ctx), true);
});

test('detectPhaseCluster returns false for enumerative-but-not-phase cluster', () => {
  // ENUM_ONLY_CONTEXT has "opciones" and "implementación" but no phase signals
  assert.equal(detectPhaseCluster(ENUM_ONLY_CONTEXT), false);
});

test('detectPhaseCluster returns false for non-enumerative cluster', () => {
  assert.equal(detectPhaseCluster(NON_ENUM_CONTEXT), false);
});

// ==================== buildCardGenerationPrompt — phase priority ====================

test('buildCardGenerationPrompt includes phase-first rule and ASAP example for phase cluster', () => {
  const prompt = buildCardGenerationPrompt(ASAP_PHASE_CONTEXT, { maxVariants: 7 });
  assert.ok(prompt.includes('PRIMERA variante del array DEBE ser una pregunta de enumeración de fases'),
    'prompt must require phase card as first variant');
  assert.ok(prompt.includes('Business Blueprint / Plano de negocios'),
    'prompt must include ASAP example with synonym bullet');
  assert.ok(prompt.includes('GoLive y soporte'),
    'prompt must include GoLive phase in example');
});

test('buildCardGenerationPrompt uses general enum rule (not phase rule) for non-phase enumerative cluster', () => {
  const prompt = buildCardGenerationPrompt(ENUM_ONLY_CONTEXT, { maxVariants: 7 });
  assert.ok(!prompt.includes('PRIMERA variante del array DEBE ser una pregunta de enumeración de fases'),
    'general enum cluster must not get phase-first rule');
  assert.ok(prompt.includes('22-enum'),
    'general enum cluster must still get 22-enum rule');
});

test('buildCardGenerationPrompt omits 22-enum for non-enumerative cluster', () => {
  const prompt = buildCardGenerationPrompt(NON_ENUM_CONTEXT, { maxVariants: 7 });
  assert.ok(!prompt.includes('22-enum'));
});

// ==================== validateGeneratedCardDraft — ASAP 5-bullet phase answer ====================

test('validateGeneratedCardDraft accepts 5-bullet ASAP phase answer', () => {
  const asapAnswer = [
    '- Preparación del proyecto',
    '- Business Blueprint / Plano de negocios',
    '- Realización',
    '- Preparación final',
    '- Entrada en producción / GoLive y soporte',
  ].join('\n');
  const v = { ...VALID_VARIANT, expected_answer: asapAnswer };
  const output = { card_group: VALID_OUTPUT.card_group, variants: [v] };
  const result = validateGeneratedCardDraft(output, CONTEXT, 9);
  assert.ok(result.validVariants.length > 0, '5-bullet ASAP phase answer must pass validation');
});
