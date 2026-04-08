import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findDuplicatedSessionItems } from '../session-planner.js';

test('detecta tarjetas duplicadas en la misma sesión por prompt normalizado', () => {
  const duplicates = findDuplicatedSessionItems(
    [
      { id: 10, prompt_text: '¿Qué es una derivada?' },
      { id: 11, prompt_text: '  ¿Qué   es una derivada?  ' },
    ],
    []
  );

  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].length, 2);
  assert.deepEqual(
    duplicates[0].map((item) => item.type),
    ['card', 'card']
  );
});

test('detecta duplicados cruzados entre tarjeta y microconsigna', () => {
  const duplicates = findDuplicatedSessionItems(
    [{ id: 20, prompt_text: 'Definí gradiente descendente' }],
    [{ id: 30, question: 'definí   gradiente descendente' }]
  );

  assert.equal(duplicates.length, 1);
  assert.deepEqual(
    duplicates[0].map((item) => item.type),
    ['card', 'micro']
  );
});

test('ignora textos vacíos y no marca falsos positivos', () => {
  const duplicates = findDuplicatedSessionItems(
    [
      { id: 1, prompt_text: '' },
      { id: 2, prompt_text: 'Pregunta A' },
    ],
    [
      { id: 3, question: 'Pregunta B' },
      { id: 4, question: null },
    ]
  );

  assert.equal(duplicates.length, 0);
});
