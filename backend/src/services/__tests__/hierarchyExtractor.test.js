import test from 'node:test';
import assert from 'node:assert/strict';

import { detectDocumentMode, extractHierarchy } from '../hierarchyExtractor.service.js';

test('detectDocumentMode detects slide-like docs', () => {
  const pages = [
    { pageNumber: 1, lines: [{ text: '1' }, { text: 'TÍTULO' }, { text: 'Punto corto' }] },
    { pageNumber: 2, lines: [{ text: '2' }, { text: 'OTRO TÍTULO' }, { text: 'Otro punto' }] },
  ];
  assert.equal(detectDocumentMode(pages), 'SLIDE_PDF');
});

test('extractHierarchy builds dense structural paths from numbered headings', () => {
  const raw = [
    'Capítulo 1 Introducción',
    'Texto intro',
    '1.1 Objetivos',
    'Detalle objetivos',
    '1.2 Alcance',
    'Detalle alcance',
  ].join('\n');

  const result = extractHierarchy(raw, { docTitle: 'Doc', forceMode: 'DENSE_PDF' });
  assert.equal(result.mode, 'DENSE_PDF');
  assert.ok(result.chunks.length >= 2);
  assert.deepEqual(result.chunks[0].structural_path, ['Capítulo 1 Introducción']);
  assert.equal(result.chunks[0].depth, 1);
});
