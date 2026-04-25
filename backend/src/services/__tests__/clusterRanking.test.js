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
  computeRelativeImportanceScores,
  assignRelativePriorityTiers,
  promoteTier,
  applyExternalSignalTierOverrides,
  getMatchStrength,
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

test('buildImportanceReasons includes low density message for density < 0.30', () => {
  const reasons = buildImportanceReasons({ density: 0.2, coverage: 0.1, intensity: 0.3, program: null, exam: null });
  assert.ok(reasons.some(r => r.includes('Baja presencia')), `expected baja presencia, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons includes recognizable-but-low density message for density in [0.30, 0.50)', () => {
  const reasons = buildImportanceReasons({ density: 0.35, coverage: 0.2, intensity: 0.4, program: null, exam: null });
  assert.ok(reasons.some(r => r.includes('reconocible')), `expected reconocible, got: ${JSON.stringify(reasons)}`);
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

// ---- buildImportanceReasons — new signal-strength and relative-tier rules ----

test('buildImportanceReasons does not mention exam when exam_score < 0.72', () => {
  const reasons = buildImportanceReasons({
    density: 0.5, coverage: 0.3, intensity: 0.5,
    program: null, exam: 0.57,
  });
  assert.ok(!reasons.some(r => r.toLowerCase().includes('examen')),
    `should not mention examen for weak score, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons does not mention programa when program_score < 0.72', () => {
  const reasons = buildImportanceReasons({
    density: 0.5, coverage: 0.3, intensity: 0.5,
    program: 0.62, exam: null,
  });
  assert.ok(!reasons.some(r => r.toLowerCase().includes('programa')),
    `should not mention programa for weak score, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons adds tier-A relative reason mentioning top percentage', () => {
  const reasons = buildImportanceReasons({
    density: 0.6, coverage: 0.3, intensity: 0.5,
    program: null, exam: null,
    relativeTier: 'A', rank: 2, totalClusters: 10,
  });
  assert.ok(reasons.some(r => r.includes('top') && r.includes('%')),
    `expected top-N% reason for tier A, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons adds tier-B relative reason', () => {
  const reasons = buildImportanceReasons({
    density: 0.5, coverage: 0.3, intensity: 0.5,
    program: null, exam: null,
    relativeTier: 'B',
  });
  assert.ok(reasons.some(r => r.includes('importancia relativa alta')),
    `expected alta reason for tier B, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons adds tier-C relative reason', () => {
  const reasons = buildImportanceReasons({
    density: 0.5, coverage: 0.3, intensity: 0.5,
    program: null, exam: null,
    relativeTier: 'C',
  });
  assert.ok(reasons.some(r => r.includes('importancia relativa media')),
    `expected media reason for tier C, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons adds tier-D relative reason', () => {
  const reasons = buildImportanceReasons({
    density: 0.3, coverage: 0.1, intensity: 0.3,
    program: null, exam: null,
    relativeTier: 'D',
  });
  assert.ok(reasons.some(r => r.includes('importancia relativa baja')),
    `expected baja reason for tier D, got: ${JSON.stringify(reasons)}`);
});

// ---- computeRelativeImportanceScores ----

test('computeRelativeImportanceScores normalizes min-max correctly', () => {
  const clusters = [
    { id: '1', importance_score: 0.34 },
    { id: '2', importance_score: 0.46 },
    { id: '3', importance_score: 0.58 },
  ];
  const result = computeRelativeImportanceScores(clusters);
  const byId = Object.fromEntries(result.map(c => [c.id, c]));

  assert.ok(Math.abs(byId['3'].relative_importance_score - 1.0) < 1e-9,
    `max cluster should have relative=1, got ${byId['3'].relative_importance_score}`);
  assert.ok(Math.abs(byId['1'].relative_importance_score - 0.0) < 1e-9,
    `min cluster should have relative=0, got ${byId['1'].relative_importance_score}`);
  // mid: (0.46 - 0.34) / (0.58 - 0.34) = 0.12 / 0.24 = 0.5
  assert.ok(Math.abs(byId['2'].relative_importance_score - 0.5) < 1e-9,
    `mid cluster should have relative=0.5, got ${byId['2'].relative_importance_score}`);
});

test('computeRelativeImportanceScores returns 0.5 when all scores are equal', () => {
  const clusters = [
    { id: '1', importance_score: 0.45 },
    { id: '2', importance_score: 0.45 },
    { id: '3', importance_score: 0.45 },
  ];
  const result = computeRelativeImportanceScores(clusters);
  for (const c of result) {
    assert.ok(Math.abs(c.relative_importance_score - 0.5) < 1e-9,
      `all equal scores should give relative=0.5, got ${c.relative_importance_score}`);
  }
});

test('computeRelativeImportanceScores returns null when no finite scores', () => {
  const clusters = [
    { id: '1', importance_score: NaN },
    { id: '2', importance_score: null },
  ];
  const result = computeRelativeImportanceScores(clusters);
  for (const c of result) {
    assert.equal(c.relative_importance_score, null);
  }
});

// ---- assignRelativePriorityTiers ----

test('assignRelativePriorityTiers assigns A/B/C/D by proportions for N=10', () => {
  const clusters = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    name: `C${i}`,
    importance_score: (10 - i) / 10,
  }));
  const result = assignRelativePriorityTiers(clusters);

  const tiers = result.map(c => c.relative_priority_tier);
  const aCnt = tiers.filter(t => t === 'A').length;
  const bCnt = tiers.filter(t => t === 'B').length;
  const cCnt = tiers.filter(t => t === 'C').length;
  const dCnt = tiers.filter(t => t === 'D').length;

  // N=10: aCount=2, bCount=3, cCount=3, dCount=2
  assert.equal(aCnt, 2, `expected 2 A tiers, got ${aCnt}`);
  assert.equal(bCnt, 3, `expected 3 B tiers, got ${bCnt}`);
  assert.equal(cCnt, 3, `expected 3 C tiers, got ${cCnt}`);
  assert.equal(dCnt, 2, `expected 2 D tiers, got ${dCnt}`);
  assert.equal(aCnt + bCnt + cCnt + dCnt, 10);
});

test('assignRelativePriorityTiers works with N=1', () => {
  const result = assignRelativePriorityTiers([{ id: '1', name: 'X', importance_score: 0.5 }]);
  assert.equal(result.length, 1);
  // aCount=max(1,ceil(0.2))=1, everything is A
  assert.equal(result[0].relative_priority_tier, 'A');
});

test('assignRelativePriorityTiers works with N=2', () => {
  const result = assignRelativePriorityTiers([
    { id: '1', name: 'A', importance_score: 0.8 },
    { id: '2', name: 'B', importance_score: 0.4 },
  ]);
  assert.equal(result.length, 2);
  const tiers = new Set(result.map(c => c.relative_priority_tier));
  // aCount=1, bCount=1, total=2, cCount=max(0,2-1-1)=0, dCount=0
  assert.ok(tiers.has('A'), 'should have A');
  assert.ok(tiers.has('B'), 'should have B');
  assert.ok(!tiers.has('D'), 'should not have D for N=2');
});

test('assignRelativePriorityTiers works with N=3', () => {
  const clusters = [
    { id: '1', name: 'A', importance_score: 0.9 },
    { id: '2', name: 'B', importance_score: 0.6 },
    { id: '3', name: 'C', importance_score: 0.3 },
  ];
  const result = assignRelativePriorityTiers(clusters);
  assert.equal(result.length, 3);
  // aCount=max(1,ceil(0.6))=1, bCount=max(1,ceil(0.9))=1, cCount=max(0,3-1-1)=1, dCount=0
  const total = result.reduce((acc, c) => {
    acc[c.relative_priority_tier] = (acc[c.relative_priority_tier] || 0) + 1;
    return acc;
  }, {});
  assert.equal(total['A'], 1);
  assert.equal(total['B'], 1);
  assert.equal((total['C'] || 0) + (total['D'] || 0), 1);
});

test('assignRelativePriorityTiers returns empty array for empty input', () => {
  assert.deepEqual(assignRelativePriorityTiers([]), []);
});

test('assignRelativePriorityTiers total tiers always equals cluster count', () => {
  for (const n of [1, 2, 3, 5, 8, 18]) {
    const clusters = Array.from({ length: n }, (_, i) => ({
      id: String(i), name: `C${i}`, importance_score: Math.random(),
    }));
    const result = assignRelativePriorityTiers(clusters);
    assert.equal(result.length, n, `total should be ${n} for n=${n}`);
  }
});

// ---- promoteTier ----

test('promoteTier does not lower a tier that is already higher', () => {
  assert.equal(promoteTier('A', 'B'), 'A');
  assert.equal(promoteTier('A', 'C'), 'A');
  assert.equal(promoteTier('A', 'D'), 'A');
  assert.equal(promoteTier('B', 'C'), 'B');
  assert.equal(promoteTier('B', 'D'), 'B');
});

test('promoteTier promotes a lower tier to the minimum required', () => {
  assert.equal(promoteTier('D', 'A'), 'A');
  assert.equal(promoteTier('C', 'B'), 'B');
  assert.equal(promoteTier('D', 'B'), 'B');
  assert.equal(promoteTier('C', 'A'), 'A');
});

test('promoteTier keeps same tier when equal', () => {
  assert.equal(promoteTier('A', 'A'), 'A');
  assert.equal(promoteTier('B', 'B'), 'B');
  assert.equal(promoteTier('C', 'C'), 'C');
  assert.equal(promoteTier('D', 'D'), 'D');
});

// ---- applyExternalSignalTierOverrides ----

test('applyExternalSignalTierOverrides promotes to A when exam_score >= 0.75', () => {
  const result = applyExternalSignalTierOverrides({
    id: '1', name: 'X',
    importance_score: 0.4,
    relative_priority_tier: 'C',
    exam_score: 0.76,
    program_score: null,
  });
  assert.equal(result.relative_priority_tier, 'A',
    `exam >= 0.75 should force tier A, got ${result.relative_priority_tier}`);
});

test('applyExternalSignalTierOverrides promotes to A when exam_score >= 0.82', () => {
  const result = applyExternalSignalTierOverrides({
    id: '1', name: 'X',
    importance_score: 0.3,
    relative_priority_tier: 'D',
    exam_score: 0.85,
    program_score: null,
  });
  assert.equal(result.relative_priority_tier, 'A');
});

test('applyExternalSignalTierOverrides promotes minimum to B when program_score >= 0.75', () => {
  const result = applyExternalSignalTierOverrides({
    id: '1', name: 'X',
    importance_score: 0.35,
    relative_priority_tier: 'D',
    exam_score: null,
    program_score: 0.78,
  });
  assert.equal(result.relative_priority_tier, 'B',
    `program >= 0.75 should force at least tier B, got ${result.relative_priority_tier}`);
});

test('applyExternalSignalTierOverrides does not downgrade A when only program >= 0.75', () => {
  const result = applyExternalSignalTierOverrides({
    id: '1', name: 'X',
    importance_score: 0.9,
    relative_priority_tier: 'A',
    exam_score: null,
    program_score: 0.80,
  });
  assert.equal(result.relative_priority_tier, 'A');
});

test('applyExternalSignalTierOverrides does not promote when scores are below thresholds', () => {
  const result = applyExternalSignalTierOverrides({
    id: '1', name: 'X',
    importance_score: 0.35,
    relative_priority_tier: 'D',
    exam_score: 0.57,
    program_score: 0.62,
  });
  assert.equal(result.relative_priority_tier, 'D',
    `weak scores should not change tier, got ${result.relative_priority_tier}`);
});

// ---- getMatchStrength ----

test('getMatchStrength returns unavailable for null', () => {
  assert.equal(getMatchStrength(null), 'unavailable');
  assert.equal(getMatchStrength(undefined), 'unavailable');
});

test('getMatchStrength returns weak for score < 0.72', () => {
  assert.equal(getMatchStrength(0.0), 'weak');
  assert.equal(getMatchStrength(0.57), 'weak');
  assert.equal(getMatchStrength(0.719), 'weak');
});

test('getMatchStrength returns moderate for score in [0.72, 0.82)', () => {
  assert.equal(getMatchStrength(0.72), 'moderate');
  assert.equal(getMatchStrength(0.75), 'moderate');
  assert.equal(getMatchStrength(0.819), 'moderate');
});

test('getMatchStrength returns strong for score >= 0.82', () => {
  assert.equal(getMatchStrength(0.82), 'strong');
  assert.equal(getMatchStrength(0.90), 'strong');
  assert.equal(getMatchStrength(1.0), 'strong');
});
