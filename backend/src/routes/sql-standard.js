import { Router } from 'express';
import { dbPool } from '../db/client.js';
import {
  extractStandardFromMaterial,
  validateCardAgainstStandard,
  looksLikeSqlAnswer,
} from '../services/sql-standard.js';

const sqlStandardRouter = Router();

// GET /sql-standard/:subject — fetch current standard for subject
sqlStandardRouter.get('/sql-standard/:subject', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      'SELECT id, name, rules, created_at, updated_at FROM sql_coding_standards WHERE user_id = $1 AND subject = $2',
      [userId, subject]
    );
    return res.json({ standard: rows[0] || null });
  } catch (err) {
    console.error('GET /sql-standard/:subject', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PUT /sql-standard/:subject — manual upsert of rules
sqlStandardRouter.put('/sql-standard/:subject', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  const { name, rules } = req.body || {};
  if (!Array.isArray(rules)) {
    return res.status(422).json({ error: 'validation_error', message: 'rules debe ser un array.' });
  }
  try {
    const { rows } = await dbPool.query(
      `INSERT INTO sql_coding_standards (user_id, subject, name, rules, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, subject) DO UPDATE SET
         name = EXCLUDED.name,
         rules = EXCLUDED.rules,
         updated_at = now()
       RETURNING id, name, rules, created_at, updated_at`,
      [userId, subject, name || '', JSON.stringify(rules)]
    );
    return res.json({ standard: rows[0] });
  } catch (err) {
    console.error('PUT /sql-standard/:subject', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /sql-standard/:subject/extract — extract standard from material via LLM
sqlStandardRouter.post('/sql-standard/:subject/extract', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  const { transcript_text, code_blocks } = req.body || {};

  if (!transcript_text?.trim() && !code_blocks?.trim()) {
    return res.status(422).json({ error: 'validation_error', message: 'Proporcioná transcript_text o code_blocks.' });
  }

  try {
    const { rules, summary } = await extractStandardFromMaterial({
      transcriptText: transcript_text || '',
      codeBlocks: code_blocks || '',
      subject,
    });

    const sourceText = [transcript_text, code_blocks].filter(Boolean).join('\n\n---\n\n');
    const { rows } = await dbPool.query(
      `INSERT INTO sql_coding_standards (user_id, subject, name, rules, source_text, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (user_id, subject) DO UPDATE SET
         rules = EXCLUDED.rules,
         source_text = EXCLUDED.source_text,
         updated_at = now()
       RETURNING id, name, rules, created_at, updated_at`,
      [userId, subject, `Estándar ${subject}`, JSON.stringify(rules), sourceText.slice(0, 50000)]
    );

    return res.json({ standard: rows[0], summary });
  } catch (err) {
    console.error('POST /sql-standard/:subject/extract', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// DELETE /sql-standard/:subject — delete standard and all validation results
sqlStandardRouter.delete('/sql-standard/:subject', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  try {
    await dbPool.query(
      'DELETE FROM sql_coding_standards WHERE user_id = $1 AND subject = $2',
      [userId, subject]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /sql-standard/:subject', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /sql-standard/:subject/validate/:card_id — validate single card on-demand
sqlStandardRouter.post('/sql-standard/:subject/validate/:card_id', async (req, res) => {
  const { subject } = req.params;
  const cardId = Number(req.params.card_id);
  const userId = req.user.id;

  if (!Number.isFinite(cardId)) {
    return res.status(422).json({ error: 'validation_error', message: 'card_id inválido.' });
  }

  try {
    const [standardResult, cardResult] = await Promise.all([
      dbPool.query('SELECT id, rules FROM sql_coding_standards WHERE user_id = $1 AND subject = $2', [userId, subject]),
      dbPool.query('SELECT id, expected_answer_text FROM cards WHERE id = $1 AND user_id = $2', [cardId, userId]),
    ]);

    if (!standardResult.rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'No hay estándar definido para esta materia.' });
    }
    if (!cardResult.rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Tarjeta no encontrada.' });
    }

    const standard = standardResult.rows[0];
    const card = cardResult.rows[0];

    if (!looksLikeSqlAnswer(card.expected_answer_text)) {
      return res.json({ skipped: true, reason: 'La tarjeta no parece contener código SQL/PL-SQL.' });
    }

    const { compliant, violations } = await validateCardAgainstStandard({
      expectedAnswerText: card.expected_answer_text,
      standardRules: standard.rules,
    });

    await dbPool.query(
      `INSERT INTO sql_standard_validation_results (user_id, card_id, standard_id, violations, compliant, validated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (card_id, standard_id) DO UPDATE SET
         violations = EXCLUDED.violations,
         compliant = EXCLUDED.compliant,
         validated_at = now()`,
      [userId, cardId, standard.id, JSON.stringify(violations), compliant]
    );

    return res.json({ compliant, violations });
  } catch (err) {
    console.error('POST /sql-standard/:subject/validate/:card_id', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /sql-standard/:subject/validate-batch — validate all SQL cards in subject
sqlStandardRouter.post('/sql-standard/:subject/validate-batch', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;

  try {
    const standardResult = await dbPool.query(
      'SELECT id, rules FROM sql_coding_standards WHERE user_id = $1 AND subject = $2',
      [userId, subject]
    );
    if (!standardResult.rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'No hay estándar definido para esta materia.' });
    }

    const standard = standardResult.rows[0];
    const cardsResult = await dbPool.query(
      'SELECT id, expected_answer_text FROM cards WHERE user_id = $1 AND subject = $2 AND archived_at IS NULL',
      [userId, subject]
    );

    let validated = 0, skipped = 0, errors = 0;

    for (const card of cardsResult.rows) {
      if (!looksLikeSqlAnswer(card.expected_answer_text)) {
        skipped++;
        continue;
      }
      try {
        const { compliant, violations } = await validateCardAgainstStandard({
          expectedAnswerText: card.expected_answer_text,
          standardRules: standard.rules,
        });
        await dbPool.query(
          `INSERT INTO sql_standard_validation_results (user_id, card_id, standard_id, violations, compliant, validated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (card_id, standard_id) DO UPDATE SET
             violations = EXCLUDED.violations,
             compliant = EXCLUDED.compliant,
             validated_at = now()`,
          [userId, card.id, standard.id, JSON.stringify(violations), compliant]
        );
        validated++;
        // Avoid rate limits
        await new Promise(r => setTimeout(r, 300));
      } catch (_e) {
        errors++;
      }
    }

    return res.json({ validated, skipped, errors });
  } catch (err) {
    console.error('POST /sql-standard/:subject/validate-batch', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /sql-standard/:subject/results — get all validation results for subject
sqlStandardRouter.get('/sql-standard/:subject/results', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT r.id, r.card_id, r.compliant, r.violations, r.validated_at,
              c.prompt_text
       FROM sql_standard_validation_results r
       JOIN cards c ON r.card_id = c.id AND c.archived_at IS NULL
       JOIN sql_coding_standards s ON r.standard_id = s.id
       WHERE r.user_id = $1 AND s.subject = $2
       ORDER BY r.compliant ASC, r.validated_at DESC`,
      [userId, subject]
    );
    return res.json({ results: rows });
  } catch (err) {
    console.error('GET /sql-standard/:subject/results', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default sqlStandardRouter;
