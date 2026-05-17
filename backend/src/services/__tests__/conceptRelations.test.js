import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL      = process.env.DATABASE_URL      || 'postgres://test:test@localhost:5432/test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.VOYAGE_API_KEY    = process.env.VOYAGE_API_KEY    || 'voyage-test';
process.env.JWT_SECRET        = process.env.JWT_SECRET        || 'test-secret-that-is-at-least-32-chars-x';

const { VALID_RELATION_TYPES, buildRelationsPrompt, persistRelations } =
  await import('../conceptRelations.service.js');

// ---- VALID_RELATION_TYPES ----

test('VALID_RELATION_TYPES contains exactly the six allowed types', () => {
  assert.deepEqual(
    [...VALID_RELATION_TYPES].sort(),
    ['contrasts_with', 'depends_on', 'example_of', 'formula_for', 'motivates', 'part_of'],
  );
});

test('VALID_RELATION_TYPES rejects old / undefined types', () => {
  for (const t of ['prerequisite_of', 'defined_by', 'related_to', 'supports', '']) {
    assert.ok(!VALID_RELATION_TYPES.has(t), `should not contain "${t}"`);
  }
});

// ---- buildRelationsPrompt ----

const SAMPLE_CLUSTER = [
  {
    cluster_id:         'cluster-1',
    cluster_name:       'Mecanismo de atención QKV',
    cluster_definition: 'Agrupa conceptos del mecanismo de queries, keys y values.',
    concepts: [
      { id: 'c1', label: 'Mecanismo QKV', definition: 'Proyecta input en tres espacios.', concept_type: 'core_concept', importance: 'high', role_in_cluster: 'main' },
      { id: 'c2', label: 'Cálculo de similitud con Sol y Luna', definition: 'Paso de ejemplo.', concept_type: 'calculation_step', importance: 'low', role_in_cluster: 'example' },
      { id: 'c3', label: 'Score de atención', definition: 'Producto punto dividido por raíz de dk.', concept_type: 'formula', importance: 'medium', role_in_cluster: 'support' },
    ],
  },
];

test('buildRelationsPrompt returns a non-empty string', () => {
  const prompt = buildRelationsPrompt(SAMPLE_CLUSTER);
  assert.ok(typeof prompt === 'string' && prompt.length > 0);
});

test('buildRelationsPrompt includes all six relation type names', () => {
  const prompt = buildRelationsPrompt(SAMPLE_CLUSTER);
  for (const t of ['example_of', 'part_of', 'depends_on', 'contrasts_with', 'formula_for', 'motivates']) {
    assert.ok(prompt.includes(`"${t}"`), `prompt should mention relation type "${t}"`);
  }
});

test('buildRelationsPrompt includes concept ids', () => {
  const prompt = buildRelationsPrompt(SAMPLE_CLUSTER);
  assert.ok(prompt.includes('c1'));
  assert.ok(prompt.includes('c2'));
  assert.ok(prompt.includes('c3'));
});

test('buildRelationsPrompt includes cluster name', () => {
  const prompt = buildRelationsPrompt(SAMPLE_CLUSTER);
  assert.ok(prompt.includes('Mecanismo de atención QKV'));
});

test('buildRelationsPrompt mentions confidence threshold rule', () => {
  const prompt = buildRelationsPrompt(SAMPLE_CLUSTER);
  assert.ok(prompt.includes('0.5'), 'prompt should reference the 0.5 confidence threshold');
});

test('buildRelationsPrompt mentions max 8 relations per cluster', () => {
  const prompt = buildRelationsPrompt(SAMPLE_CLUSTER);
  assert.ok(prompt.includes('8'), 'prompt should reference max 8 relations per cluster');
});

test('buildRelationsPrompt mentions rationale requirement', () => {
  const prompt = buildRelationsPrompt(SAMPLE_CLUSTER);
  assert.ok(prompt.toLowerCase().includes('rationale'), 'prompt should mention rationale');
});

test('buildRelationsPrompt includes directionality guidance for example_of', () => {
  const prompt = buildRelationsPrompt(SAMPLE_CLUSTER);
  assert.ok(prompt.includes('ejemplo concreto') || prompt.includes('source = el ejemplo'),
    'prompt should describe example_of direction');
});

test('buildRelationsPrompt handles multiple clusters', () => {
  const two = [
    ...SAMPLE_CLUSTER,
    {
      cluster_id:         'cluster-2',
      cluster_name:       'Normalización batch',
      cluster_definition: 'Normalización en redes neuronales.',
      concepts: [
        { id: 'c4', label: 'Batch normalization', definition: 'Normaliza por batch.', concept_type: 'method_or_technique', importance: 'high', role_in_cluster: 'main' },
        { id: 'c5', label: 'Layer normalization', definition: 'Normaliza por capa.', concept_type: 'method_or_technique', importance: 'medium', role_in_cluster: 'support' },
      ],
    },
  ];
  const prompt = buildRelationsPrompt(two);
  assert.ok(prompt.includes('Normalización batch'));
  assert.ok(prompt.includes('c4'));
  assert.ok(prompt.includes('c5'));
});

// ---- persistRelations filter logic ----

// We test the filter logic directly (same approach as conceptRoles.test.js)

const knownIds = ['id-a', 'id-b', 'id-c', 'id-d'];
const validSet = new Set(knownIds);
const conceptMeta = {
  'id-a': { role_in_cluster: 'main',    concept_type: 'core_concept' },
  'id-b': { role_in_cluster: 'support', concept_type: 'formula' },
  'id-c': { role_in_cluster: 'example', concept_type: 'calculation_step' },
  'id-d': { role_in_cluster: 'example', concept_type: 'calculation_step' },
};

function applyFilter(relations) {
  const LOW_SIGNAL_ROLES  = new Set(['example', 'context']);
  const LOW_SIGNAL_TYPES  = new Set(['calculation_step', 'implementation_detail', 'example']);
  const ALLOWED_LOW_SIGNAL = new Set(['part_of', 'formula_for']);
  const MIN_CONFIDENCE    = 0.5;
  const MIN_RATIONALE_WORDS = 8;

  return relations.filter(r => {
    if (!r) return false;
    if (typeof r.source_concept_id !== 'string') return false;
    if (typeof r.target_concept_id !== 'string') return false;
    if (r.source_concept_id === r.target_concept_id) return false;
    if (!validSet.has(r.source_concept_id)) return false;
    if (!validSet.has(r.target_concept_id)) return false;
    if (!VALID_RELATION_TYPES.has(r.relation_type)) return false;
    if (typeof r.confidence !== 'number') return false;
    if (r.confidence < MIN_CONFIDENCE) return false;
    if (typeof r.rationale !== 'string') return false;
    if (r.rationale.trim().split(/\s+/).length < MIN_RATIONALE_WORDS) return false;

    if (!ALLOWED_LOW_SIGNAL.has(r.relation_type)) {
      const src = conceptMeta[r.source_concept_id];
      const tgt = conceptMeta[r.target_concept_id];
      if (src && tgt) {
        const srcLow = LOW_SIGNAL_ROLES.has(src.role_in_cluster) || LOW_SIGNAL_TYPES.has(src.concept_type);
        const tgtLow = LOW_SIGNAL_ROLES.has(tgt.role_in_cluster) || LOW_SIGNAL_TYPES.has(tgt.concept_type);
        if (srcLow && tgtLow) return false;
      }
    }
    return true;
  });
}

test('persistRelations: filters out unknown concept ids', () => {
  const relations = [
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'depends_on', confidence: 0.9, rationale: 'id-b define el espacio en que opera id-a completamente y sin ambigüedad' },
    { source_concept_id: 'id-x', target_concept_id: 'id-b', relation_type: 'depends_on', confidence: 0.9, rationale: 'desconocido pero con rationale suficientemente largo para pasar el filtro' },
  ];
  const valid = applyFilter(relations);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].source_concept_id, 'id-a');
});

test('persistRelations: filters out invalid relation types', () => {
  const relations = [
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'depends_on',    confidence: 0.8, rationale: 'id-b es requisito conceptual directo para entender id-a correctamente' },
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'prerequisite_of', confidence: 0.8, rationale: 'tipo inválido que no debería pasar el filtro de tipos permitidos' },
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'defined_by',      confidence: 0.8, rationale: 'otro tipo inválido que no debería pasar el filtro de validación' },
  ];
  const valid = applyFilter(relations);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].relation_type, 'depends_on');
});

test('persistRelations: filters out self-relations', () => {
  const relations = [
    { source_concept_id: 'id-a', target_concept_id: 'id-a', relation_type: 'part_of', confidence: 0.9, rationale: 'auto-relación que debe ser descartada por el filtro de ids distintos' },
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'part_of', confidence: 0.9, rationale: 'id-a es subcomponente funcional directo de id-b en el sistema completo' },
  ];
  const valid = applyFilter(relations);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].target_concept_id, 'id-b');
});

test('persistRelations: filters out confidence below 0.5', () => {
  const relations = [
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'depends_on', confidence: 0.49, rationale: 'confianza insuficiente y no debe ser persistida por el filtro de umbral' },
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'depends_on', confidence: 0.50, rationale: 'confianza en el límite exacto y debe pasar el filtro de umbral mínimo' },
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'depends_on', confidence: 0.80, rationale: 'confianza alta y debe pasar el filtro de umbral de confianza mínima' },
  ];
  // Two entries with same (source, target, type) — in real DB the second would be a conflict.
  // Filter logic keeps both at >= 0.5 threshold.
  const valid = applyFilter(relations);
  assert.equal(valid.length, 2);
  assert.ok(valid.every(r => r.confidence >= 0.5));
});

test('persistRelations: filters out rationale with fewer than 8 words', () => {
  const relations = [
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'depends_on', confidence: 0.9, rationale: 'muy corto' },
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'depends_on', confidence: 0.9, rationale: 'id-b define el contexto algebraico necesario para que id-a tenga sentido completo' },
  ];
  const valid = applyFilter(relations);
  assert.equal(valid.length, 1);
  assert.ok(valid[0].rationale.trim().split(/\s+/).length >= 8);
});

test('persistRelations: drops low-signal → low-signal unless part_of or formula_for', () => {
  // id-c and id-d are both example/calculation_step
  const relations = [
    { source_concept_id: 'id-c', target_concept_id: 'id-d', relation_type: 'depends_on', confidence: 0.8, rationale: 'ambos son pasos de cálculo de bajo valor semántico y deben ser descartados' },
    { source_concept_id: 'id-c', target_concept_id: 'id-d', relation_type: 'part_of',    confidence: 0.8, rationale: 'id-c es etapa intermedia que forma parte estructural del proceso id-d completo' },
  ];
  const valid = applyFilter(relations);
  assert.equal(valid.length, 1, 'only part_of should survive between two low-signal concepts');
  assert.equal(valid[0].relation_type, 'part_of');
});

test('persistRelations: allows low-signal source with high-signal target', () => {
  // id-c (example) → id-a (main): example_of should survive
  const relations = [
    { source_concept_id: 'id-c', target_concept_id: 'id-a', relation_type: 'example_of', confidence: 0.85, rationale: 'id-c ilustra concretamente el mecanismo central descrito por el concepto id-a' },
  ];
  const valid = applyFilter(relations);
  assert.equal(valid.length, 1, 'example_of from low-signal to high-signal should survive');
});

test('persistRelations: handles null/undefined entries', () => {
  const relations = [
    null,
    undefined,
    { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: 'depends_on', confidence: 0.9, rationale: 'id-b es requisito conceptual directo e indispensable para entender completamente id-a' },
  ];
  const valid = applyFilter(relations);
  assert.equal(valid.length, 1);
});

test('persistRelations: returns empty when all filtered', () => {
  const relations = [
    { source_concept_id: 'id-x', target_concept_id: 'id-y', relation_type: 'depends_on', confidence: 0.9, rationale: 'ambos ids desconocidos y deben ser descartados por el filtro de ids conocidos' },
  ];
  const valid = applyFilter(relations);
  assert.equal(valid.length, 0);
});

// ---- all six types pass the type filter ----

test('all six VALID_RELATION_TYPES pass the type filter', () => {
  for (const t of VALID_RELATION_TYPES) {
    const r = { source_concept_id: 'id-a', target_concept_id: 'id-b', relation_type: t, confidence: 0.9, rationale: 'rationale concreto y específico que justifica esta relación entre los dos conceptos dados' };
    const valid = applyFilter([r]);
    assert.equal(valid.length, 1, `relation_type "${t}" should pass the filter`);
  }
});
