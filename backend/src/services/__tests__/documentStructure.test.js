import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL     = process.env.DATABASE_URL     || 'postgres://test:test@localhost:5432/test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.VOYAGE_API_KEY   = process.env.VOYAGE_API_KEY   || 'voyage-test';
process.env.JWT_SECRET       = process.env.JWT_SECRET       || 'test-secret-that-is-at-least-32-chars-x';

const { validateDocumentStructure } = await import('../documentStructure.service.js');

// ---- validateDocumentStructure ----

test('accepts a valid process_stages structure', () => {
  const raw = {
    structure_type: 'process_stages',
    main_topic: 'Metodología ASAP de SAP',
    primary_axis: 'etapas cronológicas',
    ordered_sections: [
      { name: 'Preparación del Proyecto', order: 1, aliases: ['Fase 1'], description: 'Planificación inicial.' },
      { name: 'Business Blueprint',        order: 2, aliases: ['BB'],     description: 'Diseño funcional.' },
      { name: 'Realización',               order: 3, aliases: [],         description: 'Configuración del sistema.' },
      { name: 'Preparación Final',         order: 4, aliases: [],         description: 'Pruebas y formación.' },
      { name: 'GoLive y Soporte',          order: 5, aliases: ['GoLive'], description: 'Puesta en marcha.' },
    ],
    secondary_axes: ['gestión del cambio'],
  };

  const result = validateDocumentStructure(raw);
  assert.ok(result !== null, 'should not return null for valid input');
  assert.equal(result.structure_type, 'process_stages');
  assert.equal(result.ordered_sections.length, 5);
  assert.equal(result.ordered_sections[0].name, 'Preparación del Proyecto');
  assert.deepEqual(result.ordered_sections[0].aliases, ['Fase 1']);
  assert.deepEqual(result.secondary_axes, ['gestión del cambio']);
});

test('rejects unknown structure_type', () => {
  const raw = {
    structure_type: 'unknown_type',
    main_topic: 'Algo',
    primary_axis: 'eje',
    ordered_sections: [],
    secondary_axes: [],
  };
  const result = validateDocumentStructure(raw);
  assert.equal(result, null);
});

test('normalizes missing ordered_sections to empty array', () => {
  const raw = {
    structure_type: 'taxonomy',
    main_topic: 'Tipos de bases de datos',
    primary_axis: 'jerarquía conceptual',
    secondary_axes: [],
  };
  const result = validateDocumentStructure(raw);
  assert.ok(result !== null);
  assert.deepEqual(result.ordered_sections, []);
});

test('normalizes missing secondary_axes to empty array', () => {
  const raw = {
    structure_type: 'concept_lesson',
    main_topic: 'Algoritmos de ordenamiento',
    primary_axis: 'secuencia pedagógica',
    ordered_sections: [],
  };
  const result = validateDocumentStructure(raw);
  assert.ok(result !== null);
  assert.deepEqual(result.secondary_axes, []);
});

test('filters out ordered_sections with empty name', () => {
  const raw = {
    structure_type: 'process_stages',
    main_topic: 'Proyecto',
    primary_axis: 'etapas',
    ordered_sections: [
      { name: 'Etapa 1', order: 1, aliases: [], description: 'Primera.' },
      { name: '',        order: 2, aliases: [], description: 'Sin nombre.' },
      { name: 'Etapa 3', order: 3, aliases: [], description: 'Tercera.' },
    ],
    secondary_axes: [],
  };
  const result = validateDocumentStructure(raw);
  assert.ok(result !== null);
  assert.equal(result.ordered_sections.length, 2);
  assert.equal(result.ordered_sections[0].name, 'Etapa 1');
  assert.equal(result.ordered_sections[1].name, 'Etapa 3');
});

test('accepts all valid structure_type values', () => {
  const types = ['process_stages', 'taxonomy', 'comparison', 'concept_lesson', 'case_study', 'mixed'];
  for (const type of types) {
    const raw = {
      structure_type: type,
      main_topic: 'Tema',
      primary_axis: 'eje',
      ordered_sections: [],
      secondary_axes: [],
    };
    const result = validateDocumentStructure(raw);
    assert.ok(result !== null, `should accept structure_type="${type}"`);
    assert.equal(result.structure_type, type);
  }
});

test('returns null for null input', () => {
  assert.equal(validateDocumentStructure(null), null);
});

test('returns null for non-object input', () => {
  assert.equal(validateDocumentStructure('process_stages'), null);
  assert.equal(validateDocumentStructure(42), null);
});

test('preserves section order field as integer', () => {
  const raw = {
    structure_type: 'process_stages',
    main_topic: 'Proyecto',
    primary_axis: 'etapas',
    ordered_sections: [
      { name: 'Primera', order: 1, aliases: [], description: '' },
      { name: 'Segunda', order: 2, aliases: [], description: '' },
    ],
    secondary_axes: [],
  };
  const result = validateDocumentStructure(raw);
  assert.equal(typeof result.ordered_sections[0].order, 'number');
  assert.equal(result.ordered_sections[0].order, 1);
  assert.equal(result.ordered_sections[1].order, 2);
});

test('assigns fallback order when order field is missing', () => {
  const raw = {
    structure_type: 'process_stages',
    main_topic: 'Proyecto',
    primary_axis: 'etapas',
    ordered_sections: [
      { name: 'Alpha', aliases: [], description: '' },
      { name: 'Beta',  aliases: [], description: '' },
    ],
    secondary_axes: [],
  };
  const result = validateDocumentStructure(raw);
  assert.ok(result !== null);
  assert.equal(result.ordered_sections[0].order, 1);
  assert.equal(result.ordered_sections[1].order, 2);
});

// ---- buildClusteringPrompt structure injection ----

const { buildClusteringPrompt } = await import('../conceptClustering.service.js');

const SAMPLE_INPUT_JSON = JSON.stringify({ groups: [], orphans: [] });

test('buildClusteringPrompt includes ordered_sections for process_stages', () => {
  const outline = {
    structure_type: 'process_stages',
    main_topic: 'ASAP',
    primary_axis: 'etapas cronológicas',
    ordered_sections: [
      { name: 'Preparación del Proyecto', order: 1, aliases: ['Fase 1'], description: 'Inicio.' },
      { name: 'Business Blueprint',        order: 2, aliases: [],         description: 'Diseño.' },
    ],
    secondary_axes: [],
  };

  const prompt = buildClusteringPrompt(SAMPLE_INPUT_JSON, outline);
  assert.ok(prompt.includes('Preparación del Proyecto'), 'should contain first stage name');
  assert.ok(prompt.includes('Business Blueprint'),        'should contain second stage name');
  assert.ok(prompt.includes('DOCUMENTO CON ESTRUCTURA POR ETAPAS'), 'should have structure context header');
});

test('buildClusteringPrompt omits structure section when structure_type is mixed', () => {
  const outline = {
    structure_type: 'mixed',
    main_topic: 'Varios',
    primary_axis: 'múltiples ejes',
    ordered_sections: [],
    secondary_axes: [],
  };

  const prompt = buildClusteringPrompt(SAMPLE_INPUT_JSON, outline);
  assert.ok(!prompt.includes('DOCUMENTO CON ESTRUCTURA POR ETAPAS'), 'should not inject structure for mixed');
});

test('buildClusteringPrompt omits structure section when outline is null', () => {
  const prompt = buildClusteringPrompt(SAMPLE_INPUT_JSON, null);
  assert.ok(!prompt.includes('DOCUMENTO CON ESTRUCTURA POR ETAPAS'), 'should not inject structure when null');
});

test('buildClusteringPrompt omits structure section when ordered_sections is empty for process_stages', () => {
  const outline = {
    structure_type: 'process_stages',
    main_topic: 'Proyecto',
    primary_axis: 'etapas',
    ordered_sections: [],
    secondary_axes: [],
  };

  const prompt = buildClusteringPrompt(SAMPLE_INPUT_JSON, outline);
  assert.ok(!prompt.includes('DOCUMENTO CON ESTRUCTURA POR ETAPAS'), 'should not inject structure with empty sections');
});

test('buildClusteringPrompt omits structure for taxonomy with sections', () => {
  const outline = {
    structure_type: 'taxonomy',
    main_topic: 'Animales',
    primary_axis: 'jerarquía',
    ordered_sections: [{ name: 'Mamíferos', order: 1, aliases: [], description: '' }],
    secondary_axes: [],
  };

  const prompt = buildClusteringPrompt(SAMPLE_INPUT_JSON, outline);
  assert.ok(!prompt.includes('DOCUMENTO CON ESTRUCTURA POR ETAPAS'), 'should not inject structure for taxonomy');
});

test('buildClusteringPrompt sections appear in sorted order', () => {
  const outline = {
    structure_type: 'process_stages',
    main_topic: 'Proyecto',
    primary_axis: 'etapas',
    ordered_sections: [
      { name: 'Etapa C', order: 3, aliases: [], description: '' },
      { name: 'Etapa A', order: 1, aliases: [], description: '' },
      { name: 'Etapa B', order: 2, aliases: [], description: '' },
    ],
    secondary_axes: [],
  };

  const prompt = buildClusteringPrompt(SAMPLE_INPUT_JSON, outline);
  const idxA = prompt.indexOf('Etapa A');
  const idxB = prompt.indexOf('Etapa B');
  const idxC = prompt.indexOf('Etapa C');
  assert.ok(idxA < idxB, 'Etapa A should appear before Etapa B');
  assert.ok(idxB < idxC, 'Etapa B should appear before Etapa C');
});

test('buildClusteringPrompt aliases appear in structure section', () => {
  const outline = {
    structure_type: 'process_stages',
    main_topic: 'ASAP',
    primary_axis: 'etapas',
    ordered_sections: [
      { name: 'GoLive y Soporte', order: 1, aliases: ['GoLive', 'Fase 5'], description: 'Arranque.' },
    ],
    secondary_axes: [],
  };

  const prompt = buildClusteringPrompt(SAMPLE_INPUT_JSON, outline);
  assert.ok(prompt.includes('GoLive'), 'should include alias');
  assert.ok(prompt.includes('Fase 5'), 'should include second alias');
});

test('buildClusteringPrompt includes mandatory cluster-per-section language', () => {
  const outline = {
    structure_type: 'process_stages',
    main_topic: 'ASAP',
    primary_axis: 'etapas cronológicas',
    ordered_sections: [
      { name: 'Preparación del Proyecto', order: 1, aliases: [], description: 'Inicio.' },
      { name: 'Business Blueprint',        order: 2, aliases: [],  description: 'Diseño.' },
    ],
    secondary_axes: [],
  };

  const prompt = buildClusteringPrompt(SAMPLE_INPUT_JSON, outline);
  assert.ok(
    prompt.includes('DEBÉS crear exactamente un cluster por cada etapa'),
    'must contain mandatory cluster-per-section instruction'
  );
  assert.ok(
    prompt.includes('Etapa N — Nombre'),
    'must include the required cluster_name format'
  );
  assert.ok(
    prompt.includes('source_chunk'),
    'must mention source_chunk as priority signal for stage assignment'
  );
});

test('buildClusteringPrompt forbids transversal clusters explicitly', () => {
  const outline = {
    structure_type: 'process_stages',
    main_topic: 'ASAP',
    primary_axis: 'etapas',
    ordered_sections: [
      { name: 'Realización', order: 3, aliases: [], description: 'Configuración.' },
    ],
    secondary_axes: [],
  };

  const prompt = buildClusteringPrompt(SAMPLE_INPUT_JSON, outline);
  assert.ok(
    prompt.includes('NO crees clusters transversales'),
    'must explicitly forbid transversal clusters'
  );
  assert.ok(
    prompt.includes('migración de datos'),
    'must name common transversal anti-patterns'
  );
});

// ---- buildLLMInput with outline ----

const { buildLLMInput } = await import('../conceptClustering.service.js');

function makeConcept(overrides = {}) {
  return {
    id:                  overrides.id          || 'uuid-1',
    label:               overrides.label        || 'Concepto A',
    definition:          overrides.definition   || 'Definición A',
    concept_type:        overrides.concept_type || null,
    importance:          overrides.importance   || null,
    source_chunk:        overrides.source_chunk || null,
    source_chunk_index:  overrides.source_chunk_index ?? null,
    evidence:            overrides.evidence     || null,
    embedding:           [],
    cluster_id:          null,
  };
}

test('buildLLMInput includes source_chunk and evidence when outline is process_stages', () => {
  const c = makeConcept({
    id: 'uuid-a',
    source_chunk: '## Slide 11 — Business Blueprint\nContenido de la etapa',
    evidence: 'El Blueprint define la solución',
  });
  const conceptMap = new Map([['uuid-a', c]]);
  const outline = {
    structure_type: 'process_stages',
    ordered_sections: [{ name: 'Business Blueprint', order: 2, aliases: [], description: '' }],
  };

  const result = buildLLMInput([], ['uuid-a'], conceptMap, outline);
  const concept = result.orphans[0];

  assert.ok('source_chunk' in concept, 'should include source_chunk');
  assert.ok('evidence' in concept, 'should include evidence');
  assert.ok(concept.source_chunk.includes('Business Blueprint'), 'source_chunk content preserved');
});

test('buildLLMInput omits source_chunk and evidence when outline is null', () => {
  const c = makeConcept({
    id: 'uuid-b',
    source_chunk: '## Slide 5 — Realización',
    evidence: 'Configuración del sistema',
  });
  const conceptMap = new Map([['uuid-b', c]]);

  const result = buildLLMInput([], ['uuid-b'], conceptMap, null);
  const concept = result.orphans[0];

  assert.ok(!('source_chunk' in concept), 'should NOT include source_chunk when outline is null');
  assert.ok(!('evidence' in concept), 'should NOT include evidence when outline is null');
});

test('buildLLMInput omits source_chunk and evidence when outline is mixed', () => {
  const c = makeConcept({
    id: 'uuid-c',
    source_chunk: '## Slide 3',
    evidence: 'Algún texto',
  });
  const conceptMap = new Map([['uuid-c', c]]);
  const outline = { structure_type: 'mixed', ordered_sections: [] };

  const result = buildLLMInput([], ['uuid-c'], conceptMap, outline);
  const concept = result.orphans[0];

  assert.ok(!('source_chunk' in concept), 'should NOT include source_chunk for mixed');
});

test('buildLLMInput truncates long source_chunk to 120 chars', () => {
  const longChunk = 'A'.repeat(200);
  const c = makeConcept({ id: 'uuid-d', source_chunk: longChunk });
  const conceptMap = new Map([['uuid-d', c]]);
  const outline = { structure_type: 'process_stages', ordered_sections: [{ name: 'X', order: 1, aliases: [], description: '' }] };

  const result = buildLLMInput([], ['uuid-d'], conceptMap, outline);
  assert.ok(result.orphans[0].source_chunk.length <= 120, 'source_chunk should be truncated to 120 chars');
});

test('buildLLMInput omits source_chunk when concept has none (null)', () => {
  const c = makeConcept({ id: 'uuid-e', source_chunk: null, evidence: null });
  const conceptMap = new Map([['uuid-e', c]]);
  const outline = { structure_type: 'process_stages', ordered_sections: [{ name: 'X', order: 1, aliases: [], description: '' }] };

  const result = buildLLMInput([], ['uuid-e'], conceptMap, outline);
  const concept = result.orphans[0];
  assert.ok(!('source_chunk' in concept), 'should not include source_chunk key when null');
  assert.ok(!('evidence' in concept), 'should not include evidence key when null');
});
