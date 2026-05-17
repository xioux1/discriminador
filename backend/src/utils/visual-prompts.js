/**
 * Prompt for per-slide multimodal analysis.
 * Returns a function so slideNumber is embedded in the instruction,
 * helping Claude fill the slide_number field correctly even when
 * processing slides in parallel batches.
 */
export function buildSlideAnalysisPrompt(slideNumber) {
  return `Analizá esta diapositiva (número ${slideNumber}) como material de estudio universitario.

No te limites a transcribir texto. Interpretá también la estructura visual:
posición, flechas, diagramas, jerarquía, fórmulas, imágenes y relaciones espaciales.

Devolvé JSON válido con esta estructura exacta:

{
  "slide_number": ${slideNumber},
  "title": string | null,
  "visible_text": string[],
  "formulas": string[],
  "visual_description": string,
  "diagram_relations": string[],
  "teacher_intent": string,
  "concepts_candidate": [
    {
      "label": string,
      "definition": string,
      "evidence": string,
      "concept_type": "core_concept | sub_concept | example | formula | calculation_step | implementation_detail | limitation | architecture_component | method_or_technique",
      "importance": "high | medium | low"
    }
  ],
  "warnings": string[]
}

Reglas:
- No inventes contenido que no esté apoyado por la diapositiva.
- Si una imagen parece decorativa, indicarlo en warnings.
- Si una imagen transmite información conceptual, describir qué relación explica en visual_description y diagram_relations.
- Diferenciar concepto central de ejemplo visual.
- Si la slide tiene poco texto pero un diagrama importante, explicar el diagrama.
- Si el texto es ilegible, indicarlo en warnings.
- No agregues comentarios fuera del JSON.
- Respondé SOLO con el JSON. Sin texto adicional, sin markdown, sin backticks.`;
}

/**
 * Prompt for reconstructing a synthetic markdown study note
 * from the array of per-slide JSON analyses.
 */
export const MARKDOWN_RECONSTRUCTION_PROMPT = `A partir de los siguientes análisis slide por slide, construí un apunte textual claro para estudiar.

Reglas:
- Mantener el orden de las slides.
- Usar encabezados de sección con el formato exacto: "## Slide {N} — {título}" (o "## Slide {N} — Sin título" si title es null).
- Agrupar slides consecutivas si explican el mismo tema, pero mantener los encabezados individuales.
- No inventar información externa; usar solo lo que está en los análisis.
- Explicar las relaciones visuales que estaban implícitas en diagramas, usando diagram_relations y visual_description.
- Conservar fórmulas en formato LaTeX si están presentes.
- Marcar ejemplos como ejemplos (usando *Ejemplo:* antes del párrafo).
- Marcar limitaciones o advertencias (usando *Nota:* o *Advertencia:*).
- Si warnings contiene "texto ilegible" o "imagen decorativa", omitir esa slide o mencionarla brevemente.
- El resultado debe ser apto para extracción de conceptos y generación de preguntas de estudio.
- El resultado debe ser texto markdown limpio, sin bloques de código ni comentarios del proceso.

Análisis de slides:
`;
