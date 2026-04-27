import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL    = process.env.DATABASE_URL    || 'postgres://test:test@localhost:5432/test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.JWT_SECRET       = process.env.JWT_SECRET       || 'test-secret-that-is-at-least-32-chars-x';

// Import only the pure functions via dynamic import so the lazy LLM client
// is never initialized during tests (no network call needed).
const { extractCandidateCardsFromText } = await import('../cardExtraction.service.js');

// ── Validation ────────────────────────────────────────────────────────────────

test('extractCandidateCardsFromText rejects empty text string', async () => {
  await assert.rejects(
    () => extractCandidateCardsFromText({ text: '' }),
    (err) => {
      assert.equal(err.code, 'validation_error');
      return true;
    }
  );
});

test('extractCandidateCardsFromText rejects whitespace-only text', async () => {
  await assert.rejects(
    () => extractCandidateCardsFromText({ text: '   \n\t  ' }),
    (err) => {
      assert.equal(err.code, 'validation_error');
      return true;
    }
  );
});

test('extractCandidateCardsFromText rejects missing text (undefined)', async () => {
  await assert.rejects(
    () => extractCandidateCardsFromText({ text: undefined }),
    (err) => {
      assert.equal(err.code, 'validation_error');
      return true;
    }
  );
});
