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
  averageTopK,
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

test('computeImportanceScore direct exam match always beats program-only score', () => {
  // Direct match (>= 0.82) forces 1.0 — always beats any program-only score
  const withDirectExam = computeImportanceScore({ density: 0.5, program: null, exam: 0.85 });
  const withProgram    = computeImportanceScore({ density: 0.5, program: 0.9, exam: null });
  assert.ok(withDirectExam > withProgram,
    `direct exam match (${withDirectExam}) should exceed even a strong program-only score (${withProgram})`);
});

test('computeImportanceScore ramification exam gives smaller boost than a strong program', () => {
  // Ramification (0.72–0.81) only nudges by +0.10 — not a takeover
  const withRamExam = computeImportanceScore({ density: 0.5, program: null, exam: 0.8 });
  // base=0.5, nudge → 0.60
  assert.ok(Math.abs(withRamExam - 0.60) < 1e-9,
    `ramification exam=0.8 with density=0.5 should give 0.60, got ${withRamExam}`);
});

test('computeImportanceScore direct exam match (>= 0.82) forces score to 1.0', () => {
  const score = computeImportanceScore({ density: 0.1, program: null, exam: 0.82 });
  assert.equal(score, 1.0, `expected 1.0 for direct match, got ${score}`);
});

test('computeImportanceScore direct exam match overrides even low density', () => {
  const score = computeImportanceScore({ density: 0.0, program: null, exam: 0.95 });
  assert.equal(score, 1.0, `expected 1.0 regardless of density, got ${score}`);
});

test('computeImportanceScore ramification exam (0.72–0.81) gives small nudge over base', () => {
  // base = density = 0.5 (no program); nudge → 0.5 + 0.10 = 0.60
  const score = computeImportanceScore({ density: 0.5, program: null, exam: 0.76 });
  assert.ok(Math.abs(score - 0.60) < 1e-9, `expected 0.60 (nudge), got ${score}`);
});

test('computeImportanceScore ramification exam does NOT force a large floor', () => {
  // Even with low density, ramification only nudges by 0.10 — not a massive jump
  const score = computeImportanceScore({ density: 0.1, program: null, exam: 0.76 });
  assert.ok(score < 0.85, `ramification should not jump to 0.85+, got ${score}`);
  assert.ok(Math.abs(score - 0.20) < 1e-9, `expected 0.10 + 0.10 = 0.20, got ${score}`);
});

test('computeImportanceScore applies program >= 0.82 floor override to 0.75', () => {
  // base = density*0.55 + program*0.45 = 0*0.55 + 0.85*0.45 = 0.3825 → floored to 0.75
  const score = computeImportanceScore({ density: 0.0, program: 0.85, exam: null });
  assert.ok(Math.abs(score - 0.75) < 1e-9, `expected 0.75 floor, got ${score}`);
});

test('computeImportanceScore without exam uses density+program blend', () => {
  const d = 0.6, p = 0.7;
  const expected = d * 0.55 + p * 0.45;
  const score = computeImportanceScore({ density: d, program: p, exam: null });
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

test('buildImportanceReasons includes direct exam match message', () => {
  const reasons = buildImportanceReasons({ density: 0.6, coverage: 0.3, intensity: 0.5, program: null, exam: 0.88 });
  assert.ok(reasons.some(r => r.includes('Coincidencia directa con el examen')), `expected direct exam reason, got: ${JSON.stringify(reasons)}`);
});

test('buildImportanceReasons includes ramification exam match message', () => {
  const reasons = buildImportanceReasons({ density: 0.6, coverage: 0.3, intensity: 0.5, program: null, exam: 0.74 });
  assert.ok(reasons.some(r => r.includes('ramificaci')), `expected ramification exam reason, got: ${JSON.stringify(reasons)}`);
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

test('applyExternalSignalTierOverrides promotes ramification (0.72–0.81) to at least B', () => {
  const result = applyExternalSignalTierOverrides({
    id: '1', name: 'X',
    importance_score: 0.4,
    relative_priority_tier: 'C',
    exam_score: 0.76,
    program_score: null,
  });
  assert.equal(result.relative_priority_tier, 'B',
    `exam 0.72–0.81 should promote to at least B, got ${result.relative_priority_tier}`);
});

test('applyExternalSignalTierOverrides forces A for direct exam match (>= 0.82)', () => {
  const result = applyExternalSignalTierOverrides({
    id: '1', name: 'X',
    importance_score: 0.3,
    relative_priority_tier: 'D',
    exam_score: 0.85,
    program_score: null,
  });
  assert.equal(result.relative_priority_tier, 'A',
    `direct exam match should always be tier A, got ${result.relative_priority_tier}`);
});

test('applyExternalSignalTierOverrides ramification does not force A', () => {
  const result = applyExternalSignalTierOverrides({
    id: '1', name: 'X',
    importance_score: 0.3,
    relative_priority_tier: 'D',
    exam_score: 0.76,
    program_score: null,
  });
  assert.notEqual(result.relative_priority_tier, 'A',
    `ramification (< 0.82) should NOT force tier A, got ${result.relative_priority_tier}`);
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

test('getMatchStrength returns related for score in [0.72, 0.82)', () => {
  assert.equal(getMatchStrength(0.72), 'related');
  assert.equal(getMatchStrength(0.75), 'related');
  assert.equal(getMatchStrength(0.819), 'related');
});

test('getMatchStrength returns direct for score >= 0.82', () => {
  assert.equal(getMatchStrength(0.82), 'direct');
  assert.equal(getMatchStrength(0.90), 'direct');
  assert.equal(getMatchStrength(1.0), 'direct');
});

// ---- averageTopK ----

test('averageTopK returns null for empty items', () => {
  const centroid = [1, 0, 0];
  assert.equal(averageTopK(centroid, []), null);
  assert.equal(averageTopK(centroid, null), null);
});

test('averageTopK with a single item returns that item score', () => {
  const centroid = uniformVec(4);
  const items = [{ embedding: uniformVec(4), text: 'a' }];
  const result = averageTopK(centroid, items, 3);
  assert.ok(result !== null);
  assert.ok(Math.abs(result.score - 1) < 1e-9, `expected score ~1, got ${result.score}`);
  assert.equal(result.text, 'a');
});

test('averageTopK averages top-k when more than k items exist', () => {
  const dim = 4;
  const centroid = uniformVec(dim);
  // One identical item (sim=1), two partially matching (sim~0.5), three orthogonal (sim=0)
  const items = [
    { embedding: uniformVec(dim), text: 'best' },
    { embedding: makeVec(dim, [0, 1], [1, 1]), text: 'mid1' },
    { embedding: makeVec(dim, [0, 1], [2, 1]), text: 'mid2' },
    { embedding: makeVec(dim, [1, 1]), text: 'low1' },
    { embedding: makeVec(dim, [2, 1]), text: 'low2' },
    { embedding: makeVec(dim, [3, 1]), text: 'low3' },
  ];
  const top1 = averageTopK(centroid, items, 1);
  const top3 = averageTopK(centroid, items, 3);
  assert.ok(top1 !== null && top3 !== null);
  // top-1 score is the single best (sim=1); top-3 average is lower (diluted by mid scores)
  assert.ok(top3.score < top1.score,
    `top-3 average (${top3.score}) should be lower than top-1 (${top1.score}) when mid items dilute`);
  // text is always the best match
  assert.equal(top3.text, 'best');
});

test('averageTopK top-3 score is more stable than top-1 when one outlier exists', () => {
  const dim = 8;
  const centroid = uniformVec(dim);
  // Outlier item with very high similarity (false positive), rest are moderate
  const outlier = { embedding: uniformVec(dim), text: 'outlier' };
  const moderates = Array.from({ length: 5 }, (_, i) => ({
    embedding: makeVec(dim, [i, 1]),
    text: `m${i}`,
  }));
  const items = [outlier, ...moderates];

  const top1 = averageTopK(centroid, items, 1);
  const top3 = averageTopK(centroid, items, 3);
  assert.ok(top1 !== null && top3 !== null);
  // top-3 smooths the outlier, so its score is lower than top-1
  assert.ok(top3.score <= top1.score,
    `top-3 (${top3.score}) should be <= top-1 (${top1.score})`);
});

test('averageTopK uses k=3 by default', () => {
  const dim = 4;
  const centroid = uniformVec(dim);
  const items = [
    { embedding: uniformVec(dim), text: 'a' },
    { embedding: makeVec(dim, [0, 1], [1, 0.5]), text: 'b' },
    { embedding: makeVec(dim, [1, 1], [2, 0.5]), text: 'c' },
    { embedding: makeVec(dim, [2, 1]), text: 'd' },
  ];
  const defaultK = averageTopK(centroid, items);
  const explicit3 = averageTopK(centroid, items, 3);
  assert.ok(Math.abs(defaultK.score - explicit3.score) < 1e-9,
    `default k should be 3, got different scores: ${defaultK.score} vs ${explicit3.score}`);
});

// ---- ranking with no exams (exam_score stays null) ----

test('computeImportanceScore with exam=null falls back to density-only', () => {
  const densityOnly = computeImportanceScore({ density: 0.7, program: null, exam: null });
  assert.ok(Math.abs(densityOnly - 0.7) < 1e-9,
    `density-only score should equal density (0.7), got ${densityOnly}`);
});

test('ranking pipeline still produces valid tiers when all exam_scores are null', () => {
  // Simulates the relative-scoring step with null exam_scores
  const clusters = [
    { id: '1', name: 'A', importance_score: 0.7, exam_score: null, program_score: null, density_score: 0.7, relative_priority_tier: null },
    { id: '2', name: 'B', importance_score: 0.5, exam_score: null, program_score: null, density_score: 0.5, relative_priority_tier: null },
    { id: '3', name: 'C', importance_score: 0.3, exam_score: null, program_score: null, density_score: 0.3, relative_priority_tier: null },
  ];
  const withRel  = computeRelativeImportanceScores(clusters);
  const withTiers = assignRelativePriorityTiers(withRel);
  const withOverrides = withTiers.map(applyExternalSignalTierOverrides);

  for (const c of withOverrides) {
    assert.ok(['A', 'B', 'C', 'D'].includes(c.relative_priority_tier),
      `expected valid tier, got: ${c.relative_priority_tier}`);
  }
  // Top cluster by importance_score should be tier A
  const top = withOverrides.find(c => c.id === '1');
  assert.equal(top.relative_priority_tier, 'A', 'top cluster should be A when no exams');
});
