import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvedExtension } from '../../middleware/upload.js';

// ── resolvedExtension (MIME + extension cross-check) ─────────────────────────

describe('resolvedExtension', () => {
  test('accepts PDF with matching MIME and extension', () => {
    const result = resolvedExtension('application/pdf', 'slides.pdf');
    assert.equal(result, '.pdf');
  });

  test('accepts PPTX with matching MIME and extension', () => {
    const result = resolvedExtension(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'lecture.pptx'
    );
    assert.equal(result, '.pptx');
  });

  test('rejects PDF MIME with .pptx extension (spoofing attempt)', () => {
    const result = resolvedExtension('application/pdf', 'malicious.pptx');
    assert.equal(result, null);
  });

  test('rejects PPTX MIME with .pdf extension (spoofing attempt)', () => {
    const result = resolvedExtension(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'malicious.pdf'
    );
    assert.equal(result, null);
  });

  test('rejects unsupported MIME type even with valid extension', () => {
    const result = resolvedExtension('application/msword', 'document.pdf');
    assert.equal(result, null);
  });

  test('rejects empty MIME', () => {
    const result = resolvedExtension('', 'slides.pdf');
    assert.equal(result, null);
  });

  test('rejects unknown extension', () => {
    const result = resolvedExtension('application/pdf', 'file.doc');
    assert.equal(result, null);
  });

  test('extension matching is case-insensitive', () => {
    const result = resolvedExtension('application/pdf', 'SLIDES.PDF');
    assert.equal(result, '.pdf');
  });
});

// ── safeParseSlideJson (via dynamic import to avoid top-level await issues) ───

// We test the behavior through the exported shape expected from slideAnalyzer.
// The internal safeParseSlideJson is not exported, so we test its effects
// indirectly by ensuring the module loads without error.

test('slideAnalyzer module loads without errors', async () => {
  const mod = await import('../slideAnalyzer.service.js');
  assert.equal(typeof mod.analyzeSlide, 'function');
});

test('markdownReconstructor module loads without errors', async () => {
  const mod = await import('../markdownReconstructor.service.js');
  assert.equal(typeof mod.reconstructMarkdown, 'function');
});

test('visualProcessor module loads without errors', async () => {
  const mod = await import('../visualProcessor.service.js');
  assert.equal(typeof mod.runVisualPipeline, 'function');
});

// ── visual-prompts ────────────────────────────────────────────────────────────

describe('visual-prompts', () => {
  test('buildSlideAnalysisPrompt includes slide number', async () => {
    const { buildSlideAnalysisPrompt } = await import('../../utils/visual-prompts.js');
    const prompt = buildSlideAnalysisPrompt(7);
    assert.ok(prompt.includes('7'), 'Prompt should reference the slide number');
    assert.ok(prompt.includes('"slide_number": 7'), 'JSON schema should embed the slide number');
  });

  test('MARKDOWN_RECONSTRUCTION_PROMPT is a non-empty string', async () => {
    const { MARKDOWN_RECONSTRUCTION_PROMPT } = await import('../../utils/visual-prompts.js');
    assert.equal(typeof MARKDOWN_RECONSTRUCTION_PROMPT, 'string');
    assert.ok(MARKDOWN_RECONSTRUCTION_PROMPT.length > 100);
  });

  test('buildSlideAnalysisPrompt for different slides produces different prompts', async () => {
    const { buildSlideAnalysisPrompt } = await import('../../utils/visual-prompts.js');
    const p1 = buildSlideAnalysisPrompt(1);
    const p2 = buildSlideAnalysisPrompt(42);
    assert.notEqual(p1, p2);
  });
});

// ── UPLOAD_DIR and MAX_SLIDES defaults ───────────────────────────────────────

test('UPLOAD_DIR defaults to a non-empty string', async () => {
  const { UPLOAD_DIR } = await import('../../middleware/upload.js');
  assert.equal(typeof UPLOAD_DIR, 'string');
  assert.ok(UPLOAD_DIR.length > 0);
});

test('MAX_SLIDES defaults to 60 when env var not set', async () => {
  const { MAX_SLIDES } = await import('../../middleware/upload.js');
  // The env var is not set in test environment, so should be 60
  assert.equal(MAX_SLIDES, 60);
});
