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
  assert.ok(prompt.includes('CONTEXTO ESTRUCTURAL'),      'should have structure context header');
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
  assert.ok(!prompt.includes('CONTEXTO ESTRUCTURAL'), 'should not inject structure for mixed');
});

test('buildClusteringPrompt omits structure section when outline is null', () => {
  const prompt = buildClusteringPrompt(SAMPLE_INPUT_JSON, null);
  assert.ok(!prompt.includes('CONTEXTO ESTRUCTURAL'), 'should not inject structure when null');
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
  assert.ok(!prompt.includes('CONTEXTO ESTRUCTURAL'), 'should not inject structure with empty sections');
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
  assert.ok(!prompt.includes('CONTEXTO ESTRUCTURAL'), 'should not inject structure for taxonomy');
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
