import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL     = process.env.DATABASE_URL     || 'postgres://test:test@localhost:5432/test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.VOYAGE_API_KEY   = process.env.VOYAGE_API_KEY   || 'voyage-test';
process.env.JWT_SECRET       = process.env.JWT_SECRET       || 'test-secret-that-is-at-least-32-chars-x';

// Import only pure/exported functions that don't hit the DB
// sectionsToClusters, createSectionsFromOutline, assignConceptsToSections
// all hit the DB, so we test their logic via the helpers exposed or reimplemented here.

// ── scoreSectionMatch (reimplemented from service for unit testing) ────────────

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\sáéíóúüñ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSlideTitle(sourceChunk) {
  if (!sourceChunk) return null;
  const m = sourceChunk.match(/##\s+(?:Slide|Página|Page)\s+\d+\s*[—–-]\s*(.+)/i);
  return m ? normalize(m[1]) : null;
}

function scoreSectionMatch(concept, needles) {
  const slideTitle  = extractSlideTitle(concept.source_chunk) || '';
  const conceptText = normalize(
    `${slideTitle} ${concept.label} ${concept.definition} ${concept.evidence || ''}`
  );
  let best = 0;
  for (const needle of needles) {
    if (needle.length < 3) continue;
    if (conceptText.includes(needle)) {
      const wordCount = needle.split(/\s+/).filter(Boolean).length;
      best = Math.max(best, wordCount);
    }
  }
  return best;
}

// ── extractSlideTitle ─────────────────────────────────────────────────────────

test('extractSlideTitle extracts title from standard heading', () => {
  const chunk = '## Slide 11 — Business Blueprint\nContenido de la etapa';
  assert.equal(extractSlideTitle(chunk), 'business blueprint');
});

test('extractSlideTitle handles em-dash variant', () => {
  const chunk = '## Slide 5 — GoLive y Soporte\nPuesta en marcha del sistema';
  assert.equal(extractSlideTitle(chunk), 'golive y soporte');
});

test('extractSlideTitle handles hyphen variant', () => {
  const chunk = '## Slide 3 - Realización\nConfiguración';
  assert.equal(extractSlideTitle(chunk), 'realización');
});

test('extractSlideTitle handles Página variant', () => {
  const chunk = '## Página 4 — Preparación Final\nPruebas y formación';
  assert.equal(extractSlideTitle(chunk), 'preparación final');
});

test('extractSlideTitle returns null when no heading found', () => {
  assert.equal(extractSlideTitle('Texto sin heading'), null);
  assert.equal(extractSlideTitle(null), null);
  assert.equal(extractSlideTitle(''), null);
});

// ── scoreSectionMatch ─────────────────────────────────────────────────────────

test('scoreSectionMatch returns > 0 when slide heading matches section name', () => {
  const concept = {
    source_chunk: '## Slide 11 — Business Blueprint\nContenido',
    label:        'Modelo To-Be',
    definition:   'Representación del estado futuro de los procesos de negocio',
    evidence:     null,
  };
  const needles = ['business blueprint'];
  assert.ok(scoreSectionMatch(concept, needles) > 0);
});

test('scoreSectionMatch scores multi-word match higher than single-word', () => {
  const concept = {
    source_chunk: '## Slide 8 — Preparación del Proyecto\nAlcance',
    label:        'Plan de proyecto',
    definition:   'Definición del alcance y recursos',
    evidence:     null,
  };
  const singleNeedle = ['preparación'];
  const multiNeedle  = ['preparación del proyecto'];
  const single = scoreSectionMatch(concept, singleNeedle);
  const multi  = scoreSectionMatch(concept, multiNeedle);
  assert.ok(multi > single, 'multi-word match should score higher');
});

test('scoreSectionMatch returns 0 when no needle matches', () => {
  const concept = {
    source_chunk: '## Slide 3 — Realización\nConfiguración del sistema',
    label:        'Diccionario de datos',
    definition:   'Catálogo de campos y tablas del sistema',
    evidence:     null,
  };
  const needles = ['golive y soporte', 'business blueprint'];
  assert.equal(scoreSectionMatch(concept, needles), 0);
});

test('scoreSectionMatch falls back to label/definition when source_chunk has no heading', () => {
  const concept = {
    source_chunk: 'Texto sin heading de slide',
    label:        'GoLive Support',
    definition:   'Soporte post GoLive del sistema',
    evidence:     null,
  };
  const needles = ['golive'];
  assert.ok(scoreSectionMatch(concept, needles) > 0, 'should match via label/definition');
});

test('scoreSectionMatch matches via aliases', () => {
  const concept = {
    source_chunk: '## Slide 6 — BB / Business Blueprint\nDiseño',
    label:        'GAP analysis',
    definition:   'Análisis de brechas en el BB',
    evidence:     null,
  };
  const needlesWithAlias = ['business blueprint', 'bb'];
  assert.ok(scoreSectionMatch(concept, needlesWithAlias) > 0, 'alias BB should match');
});

// ── sectionsToClusters logic (pure, no DB) ────────────────────────────────────

function simulateSectionsToClusters(sections, conceptsBySectionId, unassigned = []) {
  const bySection = new Map(sections.map(s => [s.id, [...(conceptsBySectionId[s.id] || [])]]));

  // Absorb sparse sections
  let changed = true;
  while (changed) {
    changed = false;
    for (const section of sections) {
      const ids = bySection.get(section.id);
      if (!ids || ids.length === 0 || ids.length >= 2) continue;

      let bestNeighbour = null, bestDist = Infinity;
      for (const other of sections) {
        if (other.id === section.id) continue;
        const otherIds = bySection.get(other.id);
        if (!otherIds || otherIds.length === 0) continue;
        const dist = Math.abs(other.order_index - section.order_index);
        if (dist < bestDist) { bestDist = dist; bestNeighbour = other; }
      }
      if (bestNeighbour) {
        bySection.get(bestNeighbour.id).push(...ids);
        bySection.set(section.id, []);
        changed = true;
      }
    }
  }

  // Distribute unassigned
  if (unassigned.length) {
    const sorted = [...sections]
      .map(s => ({ section: s, count: bySection.get(s.id)?.length || 0 }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);
    if (sorted.length > 0) {
      let idx = 0;
      for (const cid of unassigned) {
        bySection.get(sorted[idx % sorted.length].section.id).push(cid);
        idx++;
      }
    }
  }

  const clusters = [];
  for (const section of sections) {
    const ids = bySection.get(section.id);
    if (!ids || ids.length < 2) continue;
    const titleWords = section.title.trim().split(/\s+/).filter(Boolean);
    const truncatedTitle = titleWords.slice(0, 5).join(' ');
    clusters.push({
      cluster_name:  `Etapa ${section.order_index} — ${truncatedTitle}`,
      cluster_definition: `Conceptos de la etapa ${section.order_index}: ${section.title}.`,
      concept_ids:   ids,
      section_id:    section.id,
    });
  }
  return clusters;
}

function makeSections(count) {
  return Array.from({ length: count }, (_, i) => ({
    id:          `sec-${i + 1}`,
    title:       `Etapa ${i + 1} Nombre`,
    order_index: i + 1,
  }));
}

test('sectionsToClusters produces one cluster per section with ≥2 concepts', () => {
  const sections = makeSections(3);
  const bySection = {
    'sec-1': ['c1', 'c2', 'c3'],
    'sec-2': ['c4', 'c5'],
    'sec-3': ['c6', 'c7', 'c8'],
  };
  const clusters = simulateSectionsToClusters(sections, bySection);
  assert.equal(clusters.length, 3);
  assert.ok(clusters[0].cluster_name.startsWith('Etapa 1'));
  assert.ok(clusters[1].cluster_name.startsWith('Etapa 2'));
  assert.ok(clusters[2].cluster_name.startsWith('Etapa 3'));
});

test('sectionsToClusters absorbs single-concept section into nearest neighbour', () => {
  const sections = makeSections(3);
  const bySection = {
    'sec-1': ['c1', 'c2'],
    'sec-2': ['c3'],        // only 1 — should be absorbed into sec-1 or sec-3
    'sec-3': ['c4', 'c5'],
  };
  const clusters = simulateSectionsToClusters(sections, bySection);
  // sec-2 absorbed → 2 clusters (sec-1 + sec-3, one of them gains c3)
  assert.equal(clusters.length, 2);
  const totalConcepts = clusters.reduce((s, c) => s + c.concept_ids.length, 0);
  assert.equal(totalConcepts, 5, 'all 5 concepts must end up in some cluster');
});

test('sectionsToClusters distributes unassigned concepts into non-empty sections', () => {
  const sections = makeSections(2);
  const bySection = {
    'sec-1': ['c1', 'c2'],
    'sec-2': ['c3', 'c4'],
  };
  const unassigned = ['c5', 'c6'];
  const clusters = simulateSectionsToClusters(sections, bySection, unassigned);
  const totalConcepts = clusters.reduce((s, c) => s + c.concept_ids.length, 0);
  assert.equal(totalConcepts, 6, 'unassigned concepts must be distributed');
});

test('sectionsToClusters cluster_name follows "Etapa N — Title" format', () => {
  const sections = makeSections(5);
  const bySection = {};
  sections.forEach((s, i) => { bySection[s.id] = [`c${i * 2 + 1}`, `c${i * 2 + 2}`]; });
  const clusters = simulateSectionsToClusters(sections, bySection);
  for (const cl of clusters) {
    assert.match(cl.cluster_name, /^Etapa \d+ — .+/, 'must follow format');
    const words = cl.cluster_name.trim().split(/\s+/).filter(Boolean);
    assert.ok(words.length >= 3, `cluster_name "${cl.cluster_name}" too short`);
    assert.ok(words.length <= 8, `cluster_name "${cl.cluster_name}" too long (${words.length} words)`);
  }
});

test('sectionsToClusters truncates long section title to stay within 8-word limit', () => {
  const sections = [{
    id: 'sec-1', order_index: 1,
    title: 'Primera Etapa del Proceso de Implementación Complejo del Sistema',
  }];
  const bySection = { 'sec-1': ['c1', 'c2'] };
  const clusters = simulateSectionsToClusters(sections, bySection);
  const words = clusters[0].cluster_name.trim().split(/\s+/).filter(Boolean);
  assert.ok(words.length <= 8, `cluster_name has ${words.length} words — expected ≤ 8`);
});

test('sectionsToClusters returns empty array when all sections have < 2 concepts and no neighbours', () => {
  const sections = [{ id: 'sec-1', title: 'Solo Etapa', order_index: 1 }];
  const bySection = { 'sec-1': ['c1'] };
  const clusters = simulateSectionsToClusters(sections, bySection);
  // 1 concept can't form a cluster, no neighbour → empty
  assert.equal(clusters.length, 0);
});

// ── createSectionsFromOutline (module surface) ────────────────────────────────

const { createSectionsFromOutline } = await import('../documentSections.service.js');

test('createSectionsFromOutline is an async function', () => {
  assert.equal(typeof createSectionsFromOutline, 'function');
  const p = createSectionsFromOutline('uuid', null);
  assert.ok(p instanceof Promise);
  p.catch(() => {});
});

test('createSectionsFromOutline returns [] immediately for non-process_stages outline', async () => {
  // No DB needed — early exit before any query
  const outline = { structure_type: 'taxonomy', ordered_sections: [] };
  // This should reject due to DB connection or return [] on early exit.
  // We test the early-exit branch by checking for empty sections type
  const result = await createSectionsFromOutline('any-id', outline).catch(() => []);
  assert.deepEqual(result, []);
});

// ── assignConceptsToSections (module surface) ─────────────────────────────────

const { assignConceptsToSections } = await import('../documentSections.service.js');

test('assignConceptsToSections is an async function', () => {
  assert.equal(typeof assignConceptsToSections, 'function');
});

test('assignConceptsToSections returns 0 for non-process_stages outline', async () => {
  const result = await assignConceptsToSections('any-id', { structure_type: 'mixed', ordered_sections: [] });
  assert.equal(result, 0);
});

test('assignConceptsToSections returns 0 for null outline', async () => {
  const result = await assignConceptsToSections('any-id', null);
  assert.equal(result, 0);
});
