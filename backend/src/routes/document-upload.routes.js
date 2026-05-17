import { Router } from 'express';
import path from 'node:path';
import { mkdir, rename } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { uploadMiddleware, UPLOAD_DIR, resolvedExtension } from '../middleware/upload.js';
import { runVisualPipeline } from '../services/visualProcessor.service.js';
import { reconstructMarkdown } from '../services/markdownReconstructor.service.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Determines processing_mode from MIME type and file extension.
 * Both must match to prevent spoofing.
 */
function detectProcessingMode(mimetype, originalname) {
  const ext = resolvedExtension(mimetype, originalname);
  if (ext === '.pptx') return 'pptx_visual';
  if (ext === '.pdf')  return 'pdf_text'; // will be refined after text probe
  return null;
}

/**
 * Quick heuristic: try to count words in a PDF without loading pdf-parse
 * if the file is large. Returns a rough word count.
 * Used only to decide pdf_text vs pdf_visual.
 */
async function probePdfWordCount(filePath) {
  try {
    const { readFile } = await import('node:fs/promises');
    const mod      = await import('pdf-parse');
    const PDFParse = mod.PDFParse;
    const buffer   = await readFile(filePath);
    const parser   = new PDFParse({ data: buffer });
    const result   = await parser.getText();
    const text     = result?.text || '';
    return text.split(/\s+/).filter(Boolean).length;
  } catch {
    // If extraction fails, treat as visual (safer)
    return 0;
  }
}

// ── POST /api/documents/upload ─────────────────────────────────────────────────

router.post('/api/documents/upload', (req, res, next) => {
  // Run multer first, then handle the rest in the async continuation
  uploadMiddleware(req, res, async (multerErr) => {
    if (multerErr) {
      const status  = multerErr.status || (multerErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      const code    = multerErr.code || 'upload_error';
      const message = multerErr.code === 'LIMIT_FILE_SIZE'
        ? `File exceeds the maximum allowed size of ${process.env.UPLOAD_MAX_FILE_MB || 100} MB.`
        : multerErr.message;
      return res.status(status).json({ error: code, message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'bad_request', message: 'No file provided. Send a "file" field in multipart/form-data.' });
    }

    const userId          = req.user.id;
    const { mimetype, originalname, size, path: tmpPath } = req.file;
    const subject         = req.body?.subject ? String(req.body.subject).trim() : null;
    const safeOriginal    = path.basename(originalname).slice(0, 255);

    // Determine processing mode
    let processingMode = detectProcessingMode(mimetype, originalname);
    if (!processingMode) {
      return res.status(415).json({
        error:   'unsupported_file_type',
        message: 'Only PDF (.pdf) and PowerPoint (.pptx) files are accepted.',
      });
    }

    // Apply user override for PDFs.
    // PPTX always stays pptx_visual — the override field is ignored for PPTX.
    const rawOverride = req.body?.processing_mode ? String(req.body.processing_mode).trim() : null;
    const modeOverride = rawOverride || 'auto';

    if (processingMode === 'pdf_text' && rawOverride !== null) {
      const VALID_OVERRIDES = ['auto', 'pdf_text', 'pdf_visual'];
      if (!VALID_OVERRIDES.includes(rawOverride)) {
        return res.status(400).json({
          error:   'invalid_processing_mode',
          message: `Invalid processing_mode "${rawOverride}". Allowed values for PDF: auto, pdf_text, pdf_visual.`,
        });
      }
    }

    let probeWordCount = null;

    if (processingMode === 'pdf_text') {
      if (modeOverride === 'pdf_visual') {
        // User explicitly requested visual pipeline — skip heuristic
        processingMode = 'pdf_visual';
      } else if (modeOverride === 'pdf_text') {
        // User explicitly requested text pipeline — leave as pdf_text
      } else {
        // auto: fall back to heuristic (threshold 400 words)
        probeWordCount = await probePdfWordCount(tmpPath);
        if (probeWordCount < 400) {
          processingMode = 'pdf_visual';
        }
      }
    }

    logger.info('[UPLOAD_PROCESSING_MODE]', {
      filename:   safeOriginal,
      requested:  modeOverride,
      resolved:   processingMode,
      word_count: probeWordCount,
    });

    const isVisual = processingMode === 'pptx_visual' || processingMode === 'pdf_visual';

    try {
      // ── Insert document row ────────────────────────────────────────────────
      const { rows } = await dbPool.query(
        `INSERT INTO documents
           (user_id, original_filename, mime_type, file_size_bytes, processing_mode,
            visual_processing_status, subject)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          userId,
          safeOriginal,
          mimetype,
          size,
          processingMode,
          isVisual ? 'pending' : null,
          subject,
        ]
      );
      const documentId = rows[0].id;

      // ── Move file to permanent location ───────────────────────────────────
      const destDir  = path.join(UPLOAD_DIR, 'documents', documentId);
      const ext      = path.extname(safeOriginal).toLowerCase();
      const destFile = path.join(destDir, `original${ext}`);

      await mkdir(destDir, { recursive: true });
      await rename(tmpPath, destFile);

      // ── Persist file_path ─────────────────────────────────────────────────
      await dbPool.query(
        'UPDATE documents SET file_path = $1, updated_at = NOW() WHERE id = $2',
        [destFile, documentId]
      );

      logger.info('[documentUpload] Document created', {
        documentId, processingMode, userId, originalname: safeOriginal, size,
      });

      // ── Launch visual pipeline async ──────────────────────────────────────
      if (isVisual) {
        setImmediate(() => {
          runVisualPipeline(documentId).catch(err =>
            logger.error('[documentUpload] runVisualPipeline crashed', {
              documentId, error: err.message,
            })
          );
        });
      }

      return res.status(201).json({
        document: {
          id:                      documentId,
          original_filename:       safeOriginal,
          processing_mode:         processingMode,
          visual_processing_status: isVisual ? 'pending' : null,
          subject,
          file_size_bytes:         size,
          created_at:              new Date().toISOString(),
          message: isVisual
            ? 'File uploaded. Visual processing has started. Poll /processing-status for updates.'
            : 'File uploaded. Use /extract-concepts to process.',
        },
      });
    } catch (err) {
      return next(err);
    }
  });
});

// ── GET /api/documents/:id/processing-status ──────────────────────────────────

router.get('/api/documents/:id/processing-status', async (req, res, next) => {
  const userId     = req.user.id;
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  try {
    const { rows } = await dbPool.query(
      `SELECT
         id, processing_mode, visual_processing_status, page_count,
         processing_error, processing_started_at, processing_completed_at
       FROM documents
       WHERE id = $1 AND user_id = $2`,
      [documentId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
    }

    const doc = rows[0];

    // Count slides already analyzed
    const { rows: countRows } = await dbPool.query(
      'SELECT COUNT(*)::int AS slides_analyzed FROM document_slides WHERE document_id = $1',
      [documentId]
    );

    return res.json({
      document_id:              doc.id,
      processing_mode:          doc.processing_mode,
      visual_processing_status: doc.visual_processing_status,
      page_count:               doc.page_count,
      slides_analyzed:          countRows[0].slides_analyzed,
      processing_error:         doc.processing_error,
      processing_started_at:    doc.processing_started_at,
      processing_completed_at:  doc.processing_completed_at,
    });
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/documents/:id/slides ─────────────────────────────────────────────

router.get('/api/documents/:id/slides', async (req, res, next) => {
  const userId     = req.user.id;
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  try {
    // Verify ownership
    const { rows: docRows } = await dbPool.query(
      'SELECT id, processing_mode FROM documents WHERE id = $1 AND user_id = $2',
      [documentId, userId]
    );

    if (!docRows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
    }

    const { rows: slides } = await dbPool.query(
      `SELECT slide_number, extracted_text, visual_summary, structured_json, created_at
       FROM document_slides
       WHERE document_id = $1
       ORDER BY slide_number ASC`,
      [documentId]
    );

    return res.json({
      document_id:  documentId,
      slide_count:  slides.length,
      slides: slides.map(s => ({
        slide_number:    s.slide_number,
        // Return a relative API URL instead of the raw filesystem path
        image_url:       `/api/documents/${documentId}/slides/${s.slide_number}/image`,
        extracted_text:  s.extracted_text,
        visual_summary:  s.visual_summary,
        structured_json: s.structured_json,
        created_at:      s.created_at,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/documents/:id/slides/:slideNumber/image ──────────────────────────

router.get('/api/documents/:id/slides/:slideNumber/image', async (req, res, next) => {
  const userId      = req.user.id;
  const documentId  = req.params.id;
  const slideNumber = parseInt(req.params.slideNumber, 10);

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }
  if (!Number.isInteger(slideNumber) || slideNumber < 1) {
    return res.status(400).json({ error: 'invalid_slide', message: 'slideNumber must be a positive integer.' });
  }

  try {
    // Verify ownership
    const { rows: docRows } = await dbPool.query(
      'SELECT id FROM documents WHERE id = $1 AND user_id = $2',
      [documentId, userId]
    );
    if (!docRows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
    }

    // Fetch image_path from slide record
    const { rows: slideRows } = await dbPool.query(
      'SELECT image_path FROM document_slides WHERE document_id = $1 AND slide_number = $2',
      [documentId, slideNumber]
    );
    if (!slideRows.length || !slideRows[0].image_path) {
      return res.status(404).json({ error: 'not_found', message: 'Slide image not found.' });
    }

    const imgPath = slideRows[0].image_path;

    if (!existsSync(imgPath)) {
      return res.status(404).json({ error: 'image_missing', message: 'Slide image file does not exist on disk.' });
    }

    // Serve the file. sendFile requires absolute path.
    const absPath = path.resolve(imgPath);

    // Security: ensure the resolved path is inside UPLOAD_DIR
    const resolvedUploadDir = path.resolve(UPLOAD_DIR);
    if (!absPath.startsWith(resolvedUploadDir + path.sep)) {
      return res.status(403).json({ error: 'forbidden', message: 'Access denied.' });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(absPath);
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/documents/:id/reconstruct-markdown ──────────────────────────────
// Retries only the markdown reconstruction step for a visual document whose
// slides are already fully analyzed. Does not re-convert or re-analyze images.

router.post('/api/documents/:id/reconstruct-markdown', async (req, res, next) => {
  const userId     = req.user.id;
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  try {
    const { rows } = await dbPool.query(
      `SELECT id, processing_mode, visual_processing_status, page_count
       FROM documents WHERE id = $1 AND user_id = $2`,
      [documentId, userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
    }

    const doc = rows[0];

    if (doc.processing_mode !== 'pptx_visual' && doc.processing_mode !== 'pdf_visual') {
      return res.status(422).json({
        error:   'not_visual',
        message: 'Only visual documents (pptx_visual, pdf_visual) support markdown reconstruction.',
      });
    }

    const { rows: countRows } = await dbPool.query(
      'SELECT COUNT(*)::int AS count FROM document_slides WHERE document_id = $1',
      [documentId]
    );
    if (countRows[0].count === 0) {
      return res.status(422).json({
        error:   'no_slides',
        message: 'No slide analyses found. Re-upload and re-process the document.',
      });
    }

    await dbPool.query(
      `UPDATE documents
       SET visual_processing_status = 'reconstructing', processing_error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [documentId]
    );

    setImmediate(async () => {
      try {
        await reconstructMarkdown(documentId);
        await dbPool.query(
          `UPDATE documents
           SET visual_processing_status = 'done',
               processing_completed_at  = NOW(),
               processing_error         = NULL,
               updated_at               = NOW()
           WHERE id = $1`,
          [documentId]
        );
        logger.info('[reconstructEndpoint] Reconstruction complete', { documentId });
      } catch (err) {
        logger.error('[reconstructEndpoint] Reconstruction failed', { documentId, error: err.message });
        await dbPool.query(
          `UPDATE documents
           SET visual_processing_status = 'failed', processing_error = $1, updated_at = NOW()
           WHERE id = $2`,
          [err.message, documentId]
        ).catch(() => {});
      }
    });

    return res.status(202).json({
      status:      'queued',
      document_id: documentId,
      message:     'Markdown reconstruction started. Poll /processing-status for updates.',
    });
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/documents/:id/reset ─────────────────────────────────────────────
// Hard-resets a document's extraction state so the full pipeline can be re-run.
// Deletes: concepts (→ concept_relations), clusters, cards, document_chunk_embeddings.
// Clears: document_structure_json.
// Preserves: the original file, document_slides, and generated_markdown so visual
//            documents don't need to re-run the expensive image-analysis step.
// Requires { "confirm": true } in the request body as an intentional guard.

router.post('/api/documents/:id/reset', async (req, res, next) => {
  const userId     = req.user.id;
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  if (req.body?.confirm !== true) {
    return res.status(400).json({
      error:   'confirmation_required',
      message: 'Send { "confirm": true } in the request body to confirm the reset.',
    });
  }

  try {
    const { rows } = await dbPool.query(
      'SELECT id, processing_mode FROM documents WHERE id = $1 AND user_id = $2',
      [documentId, userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
    }

    const client = await dbPool.connect();
    let counts;
    try {
      await client.query('BEGIN');

      const [conceptsRes, clustersRes, cardsRes, embeddingsRes] = await Promise.all([
        client.query('DELETE FROM concepts               WHERE document_id = $1', [documentId]),
        client.query('DELETE FROM clusters               WHERE document_id = $1', [documentId]),
        client.query('DELETE FROM cards                  WHERE document_id = $1', [documentId]),
        client.query('DELETE FROM document_chunk_embeddings WHERE document_id = $1', [documentId]),
      ]);

      await client.query(
        'UPDATE documents SET document_structure_json = NULL, updated_at = NOW() WHERE id = $1',
        [documentId]
      );

      await client.query('COMMIT');

      counts = {
        concepts:             conceptsRes.rowCount,
        clusters:             clustersRes.rowCount,
        cards:                cardsRes.rowCount,
        chunk_embeddings:     embeddingsRes.rowCount,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    logger.info('[documentReset] Document reset complete', { documentId, userId, counts });

    return res.json({
      reset:       true,
      document_id: documentId,
      deleted:     counts,
      message:     'Document reset. Re-run concept extraction to restart the pipeline.',
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
