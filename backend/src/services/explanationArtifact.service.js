import Anthropic from '@anthropic-ai/sdk';
import { LLM_MODELS } from '../config/env.js';

const ALLOWED_DIAGRAM_TYPES = new Set(['sequence', 'concept_map', 'compare', 'step_derivation']);
const ALLOWED_REVEAL_ACTIONS = new Set([
  'show_node', 'show_edge', 'highlight_node',
  'show_column', 'show_step', 'highlight_step',
]);

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

function buildPrompt({ cardId, cardFront, cardBack, cardType, subject, language, labels }) {
  const lang = language || 'es';
  const labelsStr = Array.isArray(labels) && labels.length > 0 ? labels.join(', ') : '—';

  return {
    system: `You generate minimal structured explanation artifacts for a study app.
You must output valid JSON only. No markdown. No prose outside the JSON object.
You do not create images. You do not create SVG.
You choose one diagram type from: sequence, concept_map, compare, step_derivation.
Your job is to help the student understand the mechanism behind the answer.`,

    user: `Generate an explanation artifact for this study card.

Language: ${lang}
Subject: ${subject || '—'}
Card type: ${cardType || 'generic'}

Question:
${cardFront}

Expected answer:
${cardBack}

Labels/tags: ${labelsStr}

Allowed diagram types:
- sequence       (processes, cause-effect, workflows, biological processes)
- concept_map    (relationships, definitions, components, causes)
- compare        (differences between two or more ideas, terms, mechanisms)
- step_derivation (math, logic, formulas, proofs, procedural reasoning)

Requirements:
- Output valid JSON only.
- Keep it minimal: 3 to 6 visual elements.
- oral_explanation_short must be under 60 words.
- oral_explanation_detailed must be under 150 words.
- For sequence/concept_map: populate nodes and edges, leave columns/steps empty.
- For compare: populate columns, leave nodes/edges/steps empty.
- For step_derivation: populate steps, leave nodes/edges/columns empty.
- reveal_steps must only reference IDs that exist in the chosen structure.
- Do not invent facts beyond the expected answer.
- No markdown inside JSON fields.

Return this exact JSON structure:
{
  "version": 1,
  "card_id": "${cardId}",
  "language": "${lang}",
  "expected_answer": "...",
  "oral_explanation_short": "...",
  "oral_explanation_detailed": "...",
  "diagram": {
    "type": "...",
    "title": "...",
    "nodes": [],
    "edges": [],
    "columns": [],
    "steps": []
  },
  "reveal_steps": [],
  "quality_flags": {
    "too_complex": false,
    "needs_manual_review": false
  }
}`,
  };
}

function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') throw new Error('Artifact must be an object.');
  if (artifact.version !== 1) throw new Error('version must be 1.');
  if (!ALLOWED_DIAGRAM_TYPES.has(artifact.diagram?.type)) {
    throw new Error(`Invalid diagram type: "${artifact.diagram?.type}". Allowed: ${[...ALLOWED_DIAGRAM_TYPES].join(', ')}.`);
  }

  const { type, nodes = [], edges = [], columns = [], steps = [] } = artifact.diagram;

  // Check reveal_steps reference valid IDs
  if (Array.isArray(artifact.reveal_steps)) {
    const validIds = new Set();
    if (type === 'sequence' || type === 'concept_map') {
      nodes.forEach((n) => n?.id && validIds.add(n.id));
      edges.forEach((e) => e?.from && validIds.add(e.from));
    } else if (type === 'compare') {
      columns.forEach((c) => c?.id && validIds.add(c.id));
    } else if (type === 'step_derivation') {
      steps.forEach((s) => s?.id && validIds.add(s.id));
    }

    for (const step of artifact.reveal_steps) {
      if (!ALLOWED_REVEAL_ACTIONS.has(step.action)) {
        throw new Error(`Invalid reveal action: "${step.action}".`);
      }
      if (step.target_id && !validIds.has(step.target_id)) {
        // Non-fatal: just flag it
        artifact.quality_flags = { ...artifact.quality_flags, needs_manual_review: true };
      }
    }
  }

  // Size guard: no more than 10 nodes/columns/steps total
  const totalElements = nodes.length + columns.length + steps.length;
  if (totalElements > 10) {
    artifact.quality_flags = { ...artifact.quality_flags, too_complex: true };
  }
}

export async function generateExplanationArtifact({ cardId, cardFront, cardBack, cardType, subject, language, labels }) {
  const prompt = buildPrompt({ cardId, cardFront, cardBack, cardType, subject, language, labels });

  const message = await getClient().messages.create({
    model: LLM_MODELS.micro,
    max_tokens: 1024,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
  });

  const raw = message.content?.[0]?.text?.trim() || '';

  // Strip accidental markdown fences
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let artifact;
  try {
    artifact = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Explanation artifact JSON parse error: ${err.message}. Raw: ${jsonText.slice(0, 200)}`);
  }

  validateArtifact(artifact);

  return artifact;
}
