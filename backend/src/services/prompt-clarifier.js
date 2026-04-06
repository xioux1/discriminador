import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

export async function clarifyPrompt(promptText) {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 350,
    temperature: 0.2,
    system: `Sos un asistente que reescribe consignas para que sean claras y accionables.

Reglas:
- Conservá exactamente la intención original.
- No inventes tablas, campos ni requisitos nuevos.
- Corregí redacción ambigua y separá requisitos en lista cuando ayude.
- Mantené el idioma original.
- No uses LaTeX, Markdown ni símbolos de formato (por ejemplo $$, \\, \`).
- Si hay fórmulas, escribilas en texto plano legible.
- Devolvé SOLO el texto final, sin prefacios.`,
    messages: [{
      role: 'user',
      content: `Reescribí esta consigna para que sea clara:

${promptText}`
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
  if (!text) throw new Error('El modelo no devolvió una consigna válida.');
  return text;
}
