import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\sáéíóúüñ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts the slide title from a source_chunk that starts with
 * "## Slide N — Title" (or Página/Page variants).
 * Returns null if no heading is found.
 */
function extractSlideTitle(sourceChunk) {
  if (!sourceChunk) return null;
  const m = sourceChunk.match(/##\s+(?:Slide|Página|Page)\s+\d+\s*[—–-]\s*(.+)/i);
  return m ? normalize(m[1]) : null;
}

/**
 * Builds a match score for a concept against a section's needles.
 * Uses the slide heading as the primary signal (most reliable), then
 * falls back to label + definition text.
 * Returns the number of matched needle words (0 = no match).
 */
function scoreSectionMatch(concept, needles) {
  const slideTitle   = extractSlideTitle(concept.source_chunk) || '';
  const conceptText  = normalize(
    `${slideTitle} ${concept.label} ${concept.definition} ${concept.evidence || ''}`
  );

  let best = 0;
  for (const needle of needles) {
    if (needle.length < 3) continue;
    if (conceptText.includes(needle)) {
      // Score = number of words in the matching needle (longer match = stronger signal)
      const wordCount = needle.split(/\s+/).filter(Boolean).length;
      best = Math.max(best, wordCount);
    }
  }
  return best;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Creates document_sections rows from document_structure_json.ordered_sections.
 * Idempotent: skips if sections already exist for the document.
 * Returns the created rows (empty array if skipped or not applicable).
 */
export async function createSectionsFromOutline(documentId, outline) {
  if (
    outline?.structure_type !== 'process_stages' ||
    !Array.isArray(outline.ordered_sections) ||
    outline.ordered_sections.length === 0
  ) {
    return [];
  }

  const { rows: existing } = await dbPool.query(
    'SELECT COUNT(*)::int AS count FROM document_sections WHERE document_id = $1',
    [documentId]
  );
  if (existing[0].count > 0) {
    logger.info('[documentSections] Sections already exist, skipping creation', { documentId });
    return [];
  }

  const sorted = [...outline.ordered_sections].sort((a, b) => a.order - b.order);
  const created = [];

  for (const s of sorted) {
    const { rows } = await dbPool.query(
      `INSERT INTO document_sections
         (document_id, title, section_type, order_index, source_slide_start, source_slide_end)
       VALUES ($1, $2, 'stage', $3, NULL, NULL)
       RETURNING id, title, section_type, order_index`,
      [documentId, s.name, s.order]
    );
    created.push(rows[0]);
  }

  logger.info('[documentSections] Sections created from outline', {
    documentId, count: created.length, sections: created.map(s => s.title),
  });

  return created;
}

/**
 * Assigns each concept (where section_id IS NULL) to the best-matching
 * document_section based on its source_chunk heading and label/definition text.
 *
 * Uses the aliases stored in document_structure_json.ordered_sections to build
 * a richer set of matching needles per section.
 *
 * Returns the number of concepts assigned.
 */
export async function assignConceptsToSections(documentId, outline) {
  if (
    outline?.structure_type !== 'process_stages' ||
    !Array.isArray(outline.ordered_sections) ||
    outline.ordered_sections.length === 0
  ) {
    return 0;
  }

  const { rows: sections } = await dbPool.query(
    'SELECT id, title, order_index FROM document_sections WHERE document_id = $1 ORDER BY order_index ASC',
    [documentId]
  );
  if (!sections.length) return 0;

  // Build needle sets per section (section title + aliases from outline)
  const sectionMatchers = sections.map(s => {
    const outlineSection = outline.ordered_sections.find(o => o.order === s.order_index);
    const names = [s.title, ...(outlineSection?.aliases || [])];
    const needles = names.map(normalize).filter(n => n.length >= 3);
    return { section: s, needles };
  });

  const { rows: concepts } = await dbPool.query(
    `SELECT id, source_chunk, label, definition, evidence
     FROM concepts
     WHERE document_id = $1 AND section_id IS NULL`,
    [documentId]
  );

  if (!concepts.length) return 0;

  let assigned = 0;
  const updates = []; // { sectionId, conceptId }

  for (const concept of concepts) {
    let bestSection = null;
    let bestScore   = 0;

    for (const { section, needles } of sectionMatchers) {
      const score = scoreSectionMatch(concept, needles);
      if (score > bestScore) {
        bestScore   = score;
        bestSection = section;
      }
    }

    if (bestSection && bestScore > 0) {
      updates.push({ sectionId: bestSection.id, conceptId: concept.id });
      assigned++;
    }
  }

  // Batch update in a transaction
  if (updates.length) {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      for (const { sectionId, conceptId } of updates) {
        await client.query(
          'UPDATE concepts SET section_id = $1 WHERE id = $2',
          [sectionId, conceptId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Log per-section distribution
  const distribution = {};
  for (const s of sections) distribution[s.title] = 0;
  for (const { sectionId } of updates) {
    const sec = sections.find(s => s.id === sectionId);
    if (sec) distribution[sec.title]++;
  }
  const unassigned = concepts.length - assigned;

  logger.info('[documentSections] Concepts assigned to sections', {
    documentId,
    assigned,
    unassigned,
    distribution,
  });

  return assigned;
}

/**
 * Deterministic clustering for process_stages documents.
 * Groups concepts by their section_id, names each cluster after the section,
 * and merges single-concept sections into their nearest neighbour.
 *
 * Returns an array of cluster objects compatible with validateClusteringResult,
 * or null if the section data is insufficient to produce any cluster.
 *
 * The returned objects carry an extra `section_id` field (stripped before
 * passing to validateClusteringResult if needed, but harmless there).
 */
export async function sectionsToClusters(documentId) {
  const { rows: sections } = await dbPool.query(
    'SELECT id, title, order_index FROM document_sections WHERE document_id = $1 ORDER BY order_index ASC',
    [documentId]
  );
  if (!sections.length) return null;

  const { rows: concepts } = await dbPool.query(
    'SELECT id, section_id FROM concepts WHERE document_id = $1',
    [documentId]
  );
  if (!concepts.length) return null;

  // Group concept IDs by section
  const bySection = new Map(sections.map(s => [s.id, []]));
  const unassigned = [];

  for (const c of concepts) {
    if (c.section_id && bySection.has(c.section_id)) {
      bySection.get(c.section_id).push(c.id);
    } else {
      unassigned.push(c.id);
    }
  }

  // Absorb sections with < 2 concepts into their nearest neighbour
  // (by order_index adjacency). We do this in passes until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const section of sections) {
      const ids = bySection.get(section.id);
      if (!ids || ids.length === 0) continue;
      if (ids.length >= 2) continue; // already valid

      // Find the nearest section (by absolute order distance) that already has ≥1 concept
      let bestNeighbour = null;
      let bestDist      = Infinity;

      for (const other of sections) {
        if (other.id === section.id) continue;
        const otherIds = bySection.get(other.id);
        if (!otherIds || otherIds.length === 0) continue;
        const dist = Math.abs(other.order_index - section.order_index);
        if (dist < bestDist) {
          bestDist      = dist;
          bestNeighbour = other;
        }
      }

      if (bestNeighbour) {
        bySection.get(bestNeighbour.id).push(...ids);
        bySection.set(section.id, []);
        changed = true;
      }
    }
  }

  // Absorb unassigned concepts: assign each to the section with most concepts
  // (largest mass = most likely general/transversal concepts belong there)
  if (unassigned.length) {
    // Sort sections by concept count desc to find the absorbing targets
    const sorted = [...sections]
      .map(s => ({ section: s, count: bySection.get(s.id)?.length || 0 }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);

    if (sorted.length > 0) {
      // Distribute unassigned across all non-empty sections (round-robin)
      let idx = 0;
      for (const cid of unassigned) {
        bySection.get(sorted[idx % sorted.length].section.id).push(cid);
        idx++;
      }
    }
  }

  // Build cluster objects from non-empty sections
  const clusters = [];
  for (const section of sections) {
    const ids = bySection.get(section.id);
    if (!ids || ids.length < 2) continue;

    // Enforce 2-8 word limit on cluster_name
    const titleWords = section.title.trim().split(/\s+/).filter(Boolean);
    const truncatedTitle = titleWords.slice(0, 5).join(' '); // max 5 title words → "Etapa N — X X X X X" ≤ 8
    const clusterName = `Etapa ${section.order_index} — ${truncatedTitle}`;

    clusters.push({
      cluster_name:       clusterName,
      cluster_definition: `Conceptos de la etapa ${section.order_index} del proceso: ${section.title}.`,
      concept_ids:        ids,
      section_id:         section.id,
    });
  }

  if (!clusters.length) return null;

  logger.info('[documentSections] Deterministic clusters built', {
    documentId,
    clusterCount: clusters.length,
    clusters: clusters.map(c => ({ name: c.cluster_name, concepts: c.concept_ids.length })),
  });

  return clusters;
}
