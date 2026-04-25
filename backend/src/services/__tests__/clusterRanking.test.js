import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-x';

const {
  cosineSimilarity,
  clamp01,
  computeCentroid,
  computeDensityScore,
  computeImportanceScore,
  computePriorityTier,
  buildImportanceReasons,
} = await import('../clusterRanking.service.js');

// ---- helpers ----

function makeVec(dim, ...nonZero) {
  // nonZero: [[index, value], ...]
  const v = new Array(dim).fill(0);
  for (const [i, val] of nonZero) v[i] = val;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}

function uniformVec(dim, val = 1) {
  const v = new Array(dim).fill(val);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

// ---- cosineSimilarity ----

test('cosineSimilarity returns 1 for identical vectors', () => {
  const v = [0.1, 0.2, 0.3, 0.4];
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
});

test('cosineSimilarity returns 0 for orthogonal vectors', () => {
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-9);
});

test('cosineSimilarity returns 0 for mismatched lengths', () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});

// ---- computeCentroid ----

test('computeCentroid averages correctly for simple case', () => {
  const embeddings = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const c = computeCentroid(embeddings);
  assert.ok(Math.abs(c[0] - 1 / 3) < 1e-9);
  assert.ok(Math.abs(c[1] - 1 / 3) < 1e-9);
  assert.ok(Math.abs(c[2] - 1 / 3) < 1e-9);
});

test('computeCentroid of a single embedding equals that embedding', () => {
  const emb = [0.5, 0.3, 0.2];
  const c = computeCentroid([emb]);
  for (let i = 0; i < emb.length; i++) {
    assert.ok(Math.abs(c[i] - emb[i]) < 1e-9);
  }
});

test('computeCentroid of two identical vectors equals that vector', () => {
  const emb = [1, 2, 3];
  const c = computeCentroid([emb, emb]);
  for (let i = 0; i < emb.length; i++) {
    assert.ok(Math.abs(c[i] - emb[i]) < 1e-9);
  }
});

// ---- computeDensityScore ----

test('computeDensityScore with all chunks above threshold gives coverage 1', () => {
  // Cluster centroid and all chunk embeddings pointing in the same direction
  const dim = 4;
  const centroid = uniformVec(dim);
  const chunks = Array.from({ length: 5 }, () => ({ embedding: uniformVec(dim) }));

  const result = computeDensityScore(centroid, chunks, 0.70);

  assert.ok(result.density_coverage_score > 0.99, `coverage should be ~1, got ${result.density_coverage_score}`);
  assert.ok(result.density_intensity_score > 0.99, `intensity should be ~1, got ${result.density_intensity_score}`);
  assert.ok(result.density_score > 0.99, `density should be ~1, got ${result.density_score}`);
});

test('computeDensityScore with no chunks above threshold gives coverage 0', () => {
  const dim = 4;
  const centroid = makeVec(dim, [0, 1]); // points along dim 0
  // Chunks orthogonal to centroid (points along dim 1, 2, 3...)
  const chunks = [
    { embedding: makeVec(dim, [1, 1]) },
    { embedding: makeVec(dim, [2, 1]) },
    { embedding: makeVec(dim, [3, 1]) },
  ];
  const result = computeDensityScore(centroid, chunks, 0.70);
  assert.ok(result.density_coverage_score < 0.01, `coverage should be ~0, got ${result.density_coverage_score}`);
});

test('computeDensityScore calculates coverage and intensity independently', () => {
  const dim = 4;
  const centroid = uniformVec(dim);
  // 2 identical, 2 orthogonal
  const chunks = [
    { embedding: uniformVec(dim) },
    { embedding: uniformVec(dim) },
    { embedding: makeVec(dim, [1, 1]) },
    { embedding: makeVec(dim, [2, 1]) },
  ];
  const result = computeDensityScore(centroid, chunks, 0.70);

  // Coverage = 2/4 = 0.5
  assert.ok(Math.abs(result.density_coverage_score - 0.5) < 0.01, `expected coverage ~0.5, got ${result.density_coverage_score}`);
  // Intensity uses top 4 similarities (k = min(5, 4) = 4)
  assert.ok(result.density_intensity_score > 0 && result.density_intensity_score <= 1);
});

test('computeDensityScore returns zeros for empty chunk list', () => {
  const centroid = [0.1, 0.2];
  const result = computeDensityScore(centroid, [], 0.70);
  assert.equal(result.density_score, 0);
  assert.equal(result.density_coverage_score, 0);
  assert.equal(result.density_intensity_score, 0);
});

// ---- computeImportanceScore ----

test('computeImportanceScore uses only density when program and exam are null', () => {
  const score = computeImportanceScore({ density: 0.6, program: null, exam: null });
  assert.ok(Math.abs(score - 0.6) < 1e-9, `expected 0.6, got ${score}`);
});

test('computeImportanceScore weights exam more than program', () => {
  const withExam    = computeImportanceScore({ density: 0.5, program: null, exam: 0.8 });
  const withProgram = computeImportanceScore({ density: 0.5, program: 0.8, exam: null });
  // exam=0.8 >= 0.75, so score is max(weighted, 0.85) = 0.85
  // program=0.8 < 0.82, so no floor override
  assert.ok(withExam > withProgram, `exam-dominant score (${withExam}) should exceed program-only score (${withProgram})`);
});

test('computeImportanceScore applies exam >= 0.75 floor override to 0.85', () => {
  const score = computeImportanceScore({ density: 0.1, program: null, exam: 0.76 });
  assert.ok(Math.abs(score - 0.85) < 1e-9, `expected 0.85 floor, got ${score}`);
});

test('computeImportanceScore applies exam >= 0.82 floor override to 0.92', () => {
  const score = computeImportanceScore({ density: 0.1, program: null, exam: 0.90 });
  assert.ok(Math.abs(score - 0.92) < 1e-9, `expected 0.92 floor, got ${score}`);
});

test('computeImportanceScore applies program >= 0.82 floor override to 0.75', () => {
  // density=0, program=0.85, exam=null → weighted = 0*0.55 + 0.85*0.45 = 0.3825
  // floor applied: max(0.3825, 0.75) = 0.75
  const score = computeImportanceScore({ density: 0.0, program: 0.85, exam: null });
  assert.ok(Math.abs(score - 0.75) < 1e-9, `expected 0.75 floor, got ${score}`);
});

test('computeImportanceScore combines all three signals correctly', () => {
  const d = 0.6, p = 0.7, e = 0.7;
  const expected = d * 0.30 + p * 0.25 + e * 0.45;
  const score = computeImportanceScore({ density: d, program: p, exam: e });
  // e=0.7 < 0.75, no floor override
  assert.ok(Math.abs(score - expected) < 1e-9, `expected ${expected}, got ${score}`);
});

test('computeImportanceScore clamps result to [0, 1]', () => {
  const score = computeImportanceScore({ density: 1, program: 1, exam: 1 });
  assert.equal(score, 1);
});

// ---- computePriorityTier ----

test('computePriorityTier assigns A for score >= 0.80', () => {
  assert.equal(computePriorityTier(0.80), 'A');
  assert.equal(computePriorityTier(0.95), 'A');
  assert.equal(computePriorityTier(1.0), 'A');
});

test('computePriorityTier assigns B for score in [0.65, 0.80)', () => {
  assert.equal(computePriorityTier(0.65), 'B');
  assert.equal(computePriorityTier(0.72), 'B');
  assert.equal(computePriorityTier(0.799), 'B');
});

test('computePriorityTier assigns C for score in [0.45, 0.65)', () => {
  assert.equal(computePriorityTier(0.45), 'C');
  assert.equal(computePriorityTier(0.55), 'C');
  assert.equal(computePriorityTier(0.649), 'C');
});

test('computePriorityTier assigns D for score below 0.45', () => {
  assert.equal(computePriorityTier(0.44), 'D');
  assert.equal(computePriorityTier(0.0), 'D');
});

// ---- buildImportanceReasons ----

test('buildImportanceReasons includes high density message', () => {
  const reasons = buildImportanceReasons({ density: 0.80, coverage: 0.3, intensity: 0.5, program: null, exam: null });
  assert.ok(reasons.some(r => r.includes('Alta presencia')), `expected alta presencia, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons includes moderate density message', () => {
  const reasons = buildImportanceReasons({ density: 0.55, coverage: 0.3, intensity: 0.5, program: null, exam: null });
  assert.ok(reasons.some(r => r.includes('moderada')), `expected moderada, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons includes low density message', () => {
  const reasons = buildImportanceReasons({ density: 0.3, coverage: 0.2, intensity: 0.4, program: null, exam: null });
  assert.ok(reasons.some(r => r.includes('Baja presencia')), `expected baja presencia, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons includes coverage message when coverage >= 0.50', () => {
  const reasons = buildImportanceReasons({ density: 0.6, coverage: 0.55, intensity: 0.5, program: null, exam: null });
  assert.ok(reasons.some(r => r.includes('distribuido')), `expected coverage reason, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons includes strong program match', () => {
  const reasons = buildImportanceReasons({ density: 0.6, coverage: 0.3, intensity: 0.5, program: 0.85, exam: null });
  assert.ok(reasons.some(r => r.includes('fuertemente con el programa')), `expected program reason, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons includes moderate program match', () => {
  const reasons = buildImportanceReasons({ density: 0.6, coverage: 0.3, intensity: 0.5, program: 0.75, exam: null });
  assert.ok(reasons.some(r => r.includes('moderada con el programa')), `expected program reason, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons includes strong exam match', () => {
  const reasons = buildImportanceReasons({ density: 0.6, coverage: 0.3, intensity: 0.5, program: null, exam: 0.88 });
  assert.ok(reasons.some(r => r.includes('fuertemente con material de examen')), `expected exam reason, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons includes moderate exam match', () => {
  const reasons = buildImportanceReasons({ density: 0.6, coverage: 0.3, intensity: 0.5, program: null, exam: 0.74 });
  assert.ok(reasons.some(r => r.includes('moderada con material de examen')), `expected exam reason, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons returns non-empty array for any input', () => {
  const reasons = buildImportanceReasons({ density: 0, coverage: 0, intensity: 0, program: null, exam: null });
  assert.ok(Array.isArray(reasons) && reasons.length > 0);
});
