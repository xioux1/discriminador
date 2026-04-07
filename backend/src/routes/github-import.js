import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';

const githubImportRouter = Router();
const LLM_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOTAL_BYTES = 150_000;
const MAX_FILES = 10;
const ALLOWED_EXTS = new Set(['.md', '.txt', '.py', '.js', '.ts', '.java', '.c', '.cpp', '.go', '.rs', '.html', '.css']);

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

function extOf(path) {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

// POST /import/github
githubImportRouter.post('/import/github', async (req, res) => {
  const userId = req.user.id;
  const { repo_url, subject } = req.body || {};

  if (!repo_url || typeof repo_url !== 'string') {
    return res.status(422).json({ error: 'validation_error', message: 'repo_url es obligatorio.' });
  }
  if (!subject || typeof subject !== 'string') {
    return res.status(422).json({ error: 'validation_error', message: 'subject es obligatorio.' });
  }

  // Parse owner/repo from URL
  const match = repo_url.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/);
  if (!match) {
    return res.status(422).json({ error: 'invalid_url', message: 'URL de GitHub inválida.' });
  }
  const [, owner, repo] = match;

  try {
    // 1. Fetch file tree
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
    const treeResp = await fetch(treeUrl, {
      headers: { 'User-Agent': 'discriminador-app', 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!treeResp.ok) {
      const status = treeResp.status;
      if (status === 404) return res.status(404).json({ error: 'repo_not_found', message: 'Repositorio no encontrado o privado.' });
      return res.status(502).json({ error: 'github_error', message: `GitHub devolvió ${status}.` });
    }
    const treeData = await treeResp.json();

    // Filter to allowed extensions, prefer README first, then small files
    const blobs = (treeData.tree || [])
      .filter(f => f.type === 'blob' && ALLOWED_EXTS.has(extOf(f.path)))
      .sort((a, b) => {
        const aIsReadme = a.path.toLowerCase().includes('readme') ? 0 : 1;
        const bIsReadme = b.path.toLowerCase().includes('readme') ? 0 : 1;
        if (aIsReadme !== bIsReadme) return aIsReadme - bIsReadme;
        return (a.size || 0) - (b.size || 0);
      })
      .slice(0, MAX_FILES);

    if (blobs.length === 0) {
      return res.status(422).json({ error: 'no_files', message: 'No se encontraron archivos de texto en el repositorio.' });
    }

    // 2. Fetch raw content
    let totalBytes = 0;
    const parts = [];
    for (const blob of blobs) {
      if (totalBytes >= MAX_TOTAL_BYTES) break;
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${blob.path}`;
      const rawResp = await fetch(rawUrl, { headers: { 'User-Agent': 'discriminador-app' } });
      if (!rawResp.ok) continue;
      let text = await rawResp.text();
      text = text.slice(0, 50_000); // truncate per file
      totalBytes += text.length;
      parts.push(`--- FILE: ${blob.path} ---\n${text}`);
    }

    if (parts.length === 0) {
      return res.status(422).json({ error: 'no_content', message: 'No se pudo leer el contenido del repositorio.' });
    }

    const content = parts.join('\n\n').slice(0, MAX_TOTAL_BYTES);

    // 3. LLM card generation
    const client = getClient();
    const systemPrompt = `Sos un tutor que genera tarjetas de estudio (flashcards) a partir de código fuente o documentación técnica.
Generá entre 5 y 15 tarjetas que capturen conceptos clave, definiciones, patrones o funciones importantes del material.
Cada tarjeta debe tener una pregunta concisa y una respuesta de 1-3 oraciones.
Formulá preguntas conceptuales generalizables; evitá preguntas sobre detalles muy específicos del código del repositorio.
Respondé ÚNICAMENTE con JSON válido: { "cards": [{ "prompt_text": "...", "expected_answer_text": "..." }] }`;

    const message = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 1500,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Materia: ${subject}\n\nContenido del repositorio:\n\n${content}` }]
    });

    let cards = [];
    try {
      const raw = message.content[0].text.trim();
      const jsonStr = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'));
      const parsed = JSON.parse(jsonStr);
      cards = (parsed.cards || []).filter(c => c.prompt_text && c.expected_answer_text).slice(0, 15);
    } catch (_e) {
      return res.status(502).json({ error: 'parse_error', message: 'El LLM no devolvió JSON válido.' });
    }

    if (cards.length === 0) {
      return res.status(422).json({ error: 'no_cards', message: 'No se generaron tarjetas.' });
    }

    // 4. Persist cards
    let cardsCreated = 0;
    for (const card of cards) {
      const { rowCount } = await dbPool.query(
        `INSERT INTO cards (subject, prompt_text, expected_answer_text, user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [subject, card.prompt_text.slice(0, 500), card.expected_answer_text.slice(0, 1000), userId]
      );
      cardsCreated += rowCount;
    }

    return res.json({ cards_created: cardsCreated, total_generated: cards.length });

  } catch (err) {
    console.error('POST /import/github error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default githubImportRouter;
