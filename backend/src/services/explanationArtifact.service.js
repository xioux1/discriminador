import Anthropic from '@anthropic-ai/sdk';
import { LLM_MODELS } from '../config/env.js';

const ALLOWED_DIAGRAM_TYPES = new Set(['tree', 'flow', 'compare', 'step_derivation']);
const ALLOWED_REVEAL_ACTIONS = new Set([
  'show_node', 'show_edge', 'highlight_node',
  'show_column', 'show_step', 'highlight_step',
]);

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

function buildPrompt({ cardId, cardFront, cardBack, cardType, subject, language }) {
  const lang = language || 'es';

  return {
    system: `You generate minimal structured explanation artifacts for a study app.
You must output valid JSON only. No markdown. No prose outside the JSON object.
You do not create images. You do not create SVG.
CRITICAL: The diagram must contain ONLY the information present in the expected answer. Do not add, infer, or invent any content not explicitly stated in the expected answer.`,

    user: `Generate an explanation artifact for this study card.

Language: ${lang}
Subject: ${subject || '—'}
Card type: ${cardType || 'generic'}

Question:
${cardFront}

Expected answer (use ONLY this content — copy items verbatim, do not add anything else):
${cardBack}

---
DIAGRAM TYPE SELECTION — follow this decision tree in order:

1. Do the items belong to two or more named entities with parallel attributes
   (e.g. "A has X, B has Y")? → compare

2. Do the items follow a strict temporal or causal order where each step leads
   to or causes the next? → flow

3. Does the answer derive a formula, proof, or logical procedure step by step?
   → step_derivation

4. Otherwise: is the answer a list of components, parts, or characteristics
   of a single concept? → tree

NEVER use flow for a list of components or parts of something.
NEVER use flow if removing the order between items does not change the meaning.
NEVER use tree if the items have a causal or temporal relationship.

---
FEW-SHOT EXAMPLES (one per type):

tree — "¿Cuáles son los componentes del DBMS?"
Expected answer: Motor de almacenamiento, Procesador de consultas, Gestor de transacciones
{
  "diagram": {
    "type": "tree",
    "title": "Componentes del DBMS",
    "nodes": [
      { "id": "root", "label": "DBMS", "text": "" },
      { "id": "n1", "label": "Motor de almacenamiento", "text": "" },
      { "id": "n2", "label": "Procesador de consultas", "text": "" },
      { "id": "n3", "label": "Gestor de transacciones", "text": "" }
    ],
    "edges": [
      { "from": "root", "to": "n1", "label": "" },
      { "from": "root", "to": "n2", "label": "" },
      { "from": "root", "to": "n3", "label": "" }
    ],
    "columns": [], "steps": []
  }
}

flow — "¿Cuáles son las etapas del ciclo de vida del SIG?"
Expected answer: Planificación previa, Proyecto implementación, Estabilización, Ampliación crecimiento
{
  "diagram": {
    "type": "flow",
    "title": "Ciclo de vida del SIG",
    "nodes": [
      { "id": "n1", "label": "Planificación previa", "text": "" },
      { "id": "n2", "label": "Proyecto implementación", "text": "" },
      { "id": "n3", "label": "Estabilización", "text": "" },
      { "id": "n4", "label": "Ampliación crecimiento", "text": "" }
    ],
    "edges": [], "columns": [], "steps": []
  }
}

compare — "¿Diferencias entre TCP y UDP?"
Expected answer: TCP orientado a conexión, garantiza entrega, más lento. UDP sin conexión, no garantiza, más rápido.
{
  "diagram": {
    "type": "compare",
    "title": "TCP vs UDP",
    "columns": [
      { "id": "c1", "title": "TCP", "items": ["Orientado a conexión", "Garantiza entrega", "Más lento"] },
      { "id": "c2", "title": "UDP", "items": ["Sin conexión", "No garantiza entrega", "Más rápido"] }
    ],
    "nodes": [], "edges": [], "steps": []
  }
}

step_derivation — "¿Cómo se calcula la varianza?"
Expected answer: Media μ = Σx/n, luego Σ(x-μ)², luego σ² = Σ(x-μ)²/n
{
  "diagram": {
    "type": "step_derivation",
    "title": "Cálculo de varianza",
    "steps": [
      { "id": "s1", "expression": "μ = Σx / n", "explanation": "Calcular la media" },
      { "id": "s2", "expression": "Σ(x − μ)²", "explanation": "Sumar desviaciones al cuadrado" },
      { "id": "s3", "expression": "σ² = Σ(x−μ)² / n", "explanation": "Dividir por n" }
    ],
    "nodes": [], "edges": [], "columns": []
  }
}

---
Requirements:
- Output valid JSON only.
- Copy items verbatim from the expected answer where possible.
- Do not add synonyms, context, or elaboration not present in the expected answer.
- Keep it minimal: 3 to 6 visual elements (excluding the root node in tree).
- oral_explanation_short must be under 60 words, paraphrasing only the expected answer.
- oral_explanation_detailed must be under 150 words.
- For tree: first node id must be "root"; all edges go from "root" to children only.
- For flow: nodes in order; no edges needed (order implied by array index).
- For compare: use columns only.
- For step_derivation: use steps only.
- reveal_steps must only reference IDs that exist in the diagram.
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
    "type": "tree | flow | compare | step_derivation",
    "title": "...",
    "nodes": [],
    "edges": [],
    "columns": [],
    "steps": []
  },
  "reveal_steps": [
    { "order": 1, "action": "show_node | show_column | show_step | highlight_node | highlight_step", "target_id": "...", "spoken_text": "" }
  ],
  "quality_flags": { "too_complex": false, "needs_manual_review": false }
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

  if (Array.isArray(artifact.reveal_steps)) {
    const validIds = new Set();
    if (type === 'tree' || type === 'flow') {
      nodes.forEach((n) => n?.id && validIds.add(n.id));
      edges.forEach((e) => e?.from && validIds.add(e.from));
    } else if (type === 'compare') {
      columns.forEach((c) => c?.id && validIds.add(c.id));
    } else if (type === 'step_derivation') {
      steps.forEach((s) => s?.id && validIds.add(s.id));
    }

    artifact.reveal_steps = artifact.reveal_steps.filter((step) => {
      if (!ALLOWED_REVEAL_ACTIONS.has(step.action)) return false;
      if (step.target_id && !validIds.has(step.target_id)) {
        artifact.quality_flags = { ...artifact.quality_flags, needs_manual_review: true };
      }
      return true;
    });
  }

  const totalElements = nodes.length + columns.length + steps.length;
  if (totalElements > 10) {
    artifact.quality_flags = { ...artifact.quality_flags, too_complex: true };
  }
}

export async function generateExplanationArtifact({ cardId, cardFront, cardBack, cardType, subject, language }) {
  const prompt = buildPrompt({ cardId, cardFront, cardBack, cardType, subject, language });

  const message = await getClient().messages.create({
    model: LLM_MODELS.micro,
    max_tokens: 1500,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
  });

  const raw = message.content?.[0]?.text?.trim() || '';
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
