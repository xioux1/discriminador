import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { analyzeSlide } from './slideAnalyzer.service.js';
import { reconstructMarkdown } from './markdownReconstructor.service.js';
import { UPLOAD_DIR, MAX_SLIDES } from '../middleware/upload.js';
import { extractAndPersistCourseMetadata } from './courseMetadataExtractor.service.js';

const exec = promisify(execCb);

const SLIDE_CONCURRENCY = () => Number(process.env.VISUAL_SLIDE_CONCURRENCY || 3);

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function setStatus(documentId, status, extra = {}) {
  const fields  = ['visual_processing_status = $2', 'updated_at = NOW()'];
  const values  = [documentId, status];
  let idx = 3;

  for (const [col, val] of Object.entries(extra)) {
    fields.push(`${col} = $${idx++}`);
    values.push(val);
  }

  await dbPool.query(
    `UPDATE documents SET ${fields.join(', ')} WHERE id = $1`,
    values
  );
}

async function setFailed(documentId, errorMessage) {
  logger.error('[visualProcessor] Pipeline failed', { documentId, errorMessage });
  await setStatus(documentId, 'failed', { processing_error: errorMessage }).catch(() => {});
}

// ── Image conversion ───────────────────────────────────────────────────────────

/**
 * Converts a PPTX file to PDF using LibreOffice headless.
 * Returns the path of the generated PDF in outDir.
 */
async function pptxToPdf(pptxPath, outDir) {
  await mkdir(outDir, { recursive: true });

  const cmd = [
    'libreoffice',
    '--headless',
    '--norestore',
    '--convert-to', 'pdf',
    '--outdir', JSON.stringify(outDir),
    JSON.stringify(pptxPath),
  ].join(' ');

  logger.info('[visualProcessor] LibreOffice convert', { pptxPath, outDir });

  try {
    const { stdout, stderr } = await exec(cmd, { timeout: 120_000 });
    if (stderr && !stderr.includes('Warning')) {
      logger.warn('[visualProcessor] LibreOffice stderr', { stderr: stderr.slice(0, 500) });
    }
    logger.info('[visualProcessor] LibreOffice stdout', { stdout: stdout.slice(0, 300) });
  } catch (err) {
    throw new Error(`LibreOffice conversion failed: ${err.message}`);
  }

  // LibreOffice names the output after the input filename
  const basename = path.basename(pptxPath, '.pptx');
  const pdfPath  = path.join(outDir, `${basename}.pdf`);

  // Verify the PDF was actually produced — LibreOffice may exit 0 even on failure
  try {
    await access(pdfPath);
  } catch {
    throw new Error(
      `LibreOffice exited without error but did not produce the expected PDF at "${pdfPath}". ` +
      'This can happen when LibreOffice cannot load the source file in headless mode. ' +
      'Ensure libreoffice is installed and the container has the required display libraries.'
    );
  }

  return pdfPath;
}

/**
 * Converts a PDF to JPEG images (one per page) using pdftoppm from poppler-utils.
 * Returns a sorted array of absolute image paths.
 *
 * We use pdftoppm directly instead of the pdf2pic wrapper to keep the
 * call simple and avoid hidden configuration issues.
 */
async function pdfToImages(pdfPath, outDir) {
  await mkdir(outDir, { recursive: true });

  const prefix = path.join(outDir, 'slide');

  // pdftoppm flags:
  //   -jpeg          → JPEG output
  //   -r 150         → 150 DPI (sufficient for vision; higher = larger files)
  //   -scale-to 1280 → cap width at 1280 px (saves tokens in vision API)
  const cmd = `pdftoppm -jpeg -r 150 -scale-to 1280 ${JSON.stringify(pdfPath)} ${JSON.stringify(prefix)}`;

  logger.info('[visualProcessor] pdftoppm convert', { pdfPath, outDir });

  try {
    await exec(cmd, { timeout: 180_000 });
  } catch (err) {
    throw new Error(`pdftoppm conversion failed: ${err.message}`);
  }

  // pdftoppm produces slide-1.jpg, slide-2.jpg, … (zero-padded on some versions)
  const entries = await readdir(outDir);
  const images  = entries
    .filter(f => /\.(jpe?g)$/i.test(f))
    .map(f => path.join(outDir, f))
    .sort((a, b) => {
      // Extract the numeric suffix to sort correctly (slide-1 before slide-10)
      const num = f => parseInt((path.basename(f).match(/(\d+)\.jpe?g$/i) || [0, 0])[1], 10);
      return num(a) - num(b);
    });

  return images;
}

// ── Main pipeline ──────────────────────────────────────────────────────────────

/**
 * Entry point called via setImmediate from the upload route.
 * Orchestrates the full visual processing pipeline:
 *   convert → images → analyze slides → reconstruct markdown
 *
 * All status transitions are persisted in documents.visual_processing_status
 * so the job is auditable even if the process crashes.
 */
export async function runVisualPipeline(documentId) {
  logger.info('[visualProcessor] Starting visual pipeline', { documentId });

  // ── Fetch document ──────────────────────────────────────────────────────────
  const { rows } = await dbPool.query(
    'SELECT id, file_path, processing_mode, page_count, subject, user_id FROM documents WHERE id = $1',
    [documentId]
  );

  if (!rows.length) {
    logger.error('[visualProcessor] Document not found', { documentId });
    return;
  }

  const document = rows[0];

  // ── Resume: if all slides are already in document_slides, skip straight to
  //    reconstruction. This handles a previous reconstruction timeout without
  //    re-converting or re-analyzing the images.
  if (document.page_count) {
    const { rows: existingSlides } = await dbPool.query(
      'SELECT COUNT(*)::int AS count FROM document_slides WHERE document_id = $1',
      [documentId]
    );
    if (existingSlides[0].count >= document.page_count) {
      logger.info('[visualProcessor] Slides already complete — resuming from reconstruction', {
        documentId, slideCount: existingSlides[0].count,
      });
      await setStatus(documentId, 'reconstructing', { processing_error: null });
      try {
        await reconstructMarkdown(documentId);
        await setStatus(documentId, 'done', {
          processing_completed_at: new Date().toISOString(),
          processing_error: null,
        });
        logger.info('[visualProcessor] Pipeline complete (resumed)', { documentId });
      } catch (err) {
        await setFailed(documentId, err.message);
      }
      return;
    }
  }

  // ── Mark started ────────────────────────────────────────────────────────────
  await setStatus(documentId, 'converting', {
    processing_started_at: new Date().toISOString(),
    processing_error: null,
  });

  const slideDir = path.join(UPLOAD_DIR, 'documents', documentId, 'slides');
  const tmpDir   = path.join(UPLOAD_DIR, 'tmp', `lo_${documentId}`);
  let   pdfPath  = document.file_path;

  try {
    // ── Step 1: PPTX → PDF (only for PPTX) ───────────────────────────────────
    if (document.processing_mode === 'pptx_visual') {
      pdfPath = await pptxToPdf(document.file_path, tmpDir);
    }

    // ── Step 2: PDF → images ──────────────────────────────────────────────────
    const imagePaths = await pdfToImages(pdfPath, slideDir);

    if (!imagePaths.length) {
      throw new Error('No images were produced from the document.');
    }

    // ── Step 3: Enforce slide limit ───────────────────────────────────────────
    if (imagePaths.length > MAX_SLIDES) {
      throw new Error(
        `Document has ${imagePaths.length} slides/pages, which exceeds the limit of ${MAX_SLIDES}. ` +
        'Please split the document or reduce the number of slides.'
      );
    }

    // Persist page count
    await dbPool.query(
      'UPDATE documents SET page_count = $1 WHERE id = $2',
      [imagePaths.length, documentId]
    );

    logger.info('[visualProcessor] Images ready', { documentId, count: imagePaths.length });

    // ── Step 4: Analyze slides (concurrent batches) ───────────────────────────
    await setStatus(documentId, 'analyzing');

    const concurrency = SLIDE_CONCURRENCY();
    for (let i = 0; i < imagePaths.length; i += concurrency) {
      const batch = imagePaths.slice(i, i + concurrency);
      await Promise.all(
        batch.map((imgPath, j) => {
          const slideNumber = i + j + 1; // 1-indexed
          return analyzeSlide(documentId, slideNumber, imgPath);
        })
      );
      logger.info('[visualProcessor] Batch analyzed', {
        documentId,
        progress: `${Math.min(i + concurrency, imagePaths.length)}/${imagePaths.length}`,
      });
    }

    // ── Step 5: Reconstruct markdown ──────────────────────────────────────────
    await setStatus(documentId, 'reconstructing');
    await reconstructMarkdown(documentId);

    // ── Step 6: Done ──────────────────────────────────────────────────────────
    await setStatus(documentId, 'done', {
      processing_completed_at: new Date().toISOString(),
      processing_error: null,
    });

    logger.info('[visualProcessor] Pipeline complete', { documentId });

    // Fire-and-forget: extract course metadata (exam dates, lineamientos) from markdown
    if (document.subject && document.user_id) {
      dbPool.query('SELECT generated_markdown FROM documents WHERE id = $1', [documentId])
        .then(({ rows: mdRows }) => {
          const markdown = mdRows[0]?.generated_markdown;
          if (markdown) {
            return extractAndPersistCourseMetadata(markdown, {
              subject: document.subject,
              userId: document.user_id,
              documentId,
              pool: dbPool,
            });
          }
        })
        .catch(err => logger.error('[visualProcessor] Course metadata extraction failed',
          { documentId, err: err.message }));
    }
  } catch (err) {
    await setFailed(documentId, err.message);
  } finally {
    // Always clean up the LibreOffice temp directory (intermediate PDF)
    if (document.processing_mode === 'pptx_visual') {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      logger.info('[visualProcessor] Cleaned up tmp dir', { tmpDir });
    }
  }
}
