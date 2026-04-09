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
    system: `Sos un editor de consignas de estudio. Tu ÚNICA tarea es reformular la PREGUNTA o CONSIGNA para que sea más clara. NUNCA la respondas.

REGLAS ABSOLUTAS:
1. NO respondas la consigna. NO des la respuesta correcta. NO expliques el concepto.
2. Si la consigna pide al alumno hacer algo (escribir código, resolver, explicar, calcular), reformulá ese pedido — no hagas vos esa tarea.
3. Tu output es SOLO la consigna reformulada, nada más.
4. Conservá exactamente la intención y los requisitos originales.
5. Corregí redacción ambigua; podés separar requisitos en lista si ayuda.
6. Mantené el idioma original.
7. No uses LaTeX, Markdown ni símbolos de formato ($$, \\, \`).
8. Sin prefacios, sin explicaciones, sin "Aquí la versión clara:".

EJEMPLO:
Input: "hacer cursor que recorra empleados con salario mayor a 1000"
Output: "Escribí un cursor en Oracle PL/SQL que recorra la tabla EMPLEADOS, filtre los que tienen salario mayor a 1000, e imprima por pantalla el nombre y salario de cada uno."`,
    messages: [{
      role: 'user',
      content: `Reformulá esta consigna para que sea más clara. NO la respondas:\n\n${promptText}`
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
  if (!text) throw new Error('El modelo no devolvió una consigna válida.');
  return text;
}
