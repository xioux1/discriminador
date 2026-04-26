import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import evaluateRouter, { __setCheckClientForTest, detectCheckMode, parseBinaryCheckOutput } from '../evaluate.js';
import { dbPool } from '../../db/client.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MATH_SUBJECT = 'matemática';
const SQL_SUBJECT  = 'bases-de-datos';

const INTEGRAL_EXERCISE = 'Calculá ∫ x·eˣ dx';
const INTEGRAL_EXPECTED = 'Usando integración por partes: u=x, dv=eˣdx → x·eˣ - eˣ + C';

const SQL_EXERCISE  = 'Escribí un cursor PL/SQL que recorra todos los empleados e imprima su nombre.';
const SQL_EXPECTED  = 'DECLARE CURSOR c IS SELECT nombre FROM empleados; v_nom VARCHAR2(100); BEGIN OPEN c; LOOP FETCH c INTO v_nom; EXIT WHEN c%NOTFOUND; DBMS_OUTPUT.PUT_LINE(v_nom); END LOOP; CLOSE c; END;';

// ─── Infrastructure helpers ────────────────────────────────────────────────────

const originalConnect = dbPool.connect;
const originalQuery   = dbPool.query;

afterEach(() => {
  dbPool.connect = originalConnect;
  dbPool.query   = originalQuery;
  __setCheckClientForTest(null);
});

let _insertedLogId = 1000;

function installDbMock({ captureLog } = {}) {
  dbPool.connect = async () => ({ async query() { return { rows: [], rowCount: 0 }; }, release() {} });
  dbPool.query = async (sql, params) => {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact.startsWith('INSERT INTO binary_check_log')) {
      const id = _insertedLogId++;
      if (captureLog) captureLog({ sql, params, id });
      return { rows: [{ id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
}

function mockAnthropicResponse(text) {
  __setCheckClientForTest({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text }]
      })
    }
  });
}

async function withServer(runTest) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 42 }; next(); });
  app.use(evaluateRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await runTest(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function binaryCheck(base, payload) {
  const res = await fetch(`${base}/evaluate/binary-check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { status: res.status, body: await res.json() };
}

// ─── Math tests ────────────────────────────────────────────────────────────────

test('Math: fórmula directa válida cuando la referencia es sustitución → ok', async () => {
  installDbMock();
  mockAnthropicResponse('RESULTADO: OK');

  await withServer(async (base) => {
    const { status, body } = await binaryCheck(base, {
      prompt_text:          INTEGRAL_EXERCISE,
      user_answer_text:     '∫ x·eˣ dx = x·eˣ - eˣ + C  (fórmula de tabla)',
      expected_answer_text: INTEGRAL_EXPECTED,
      subject:              MATH_SUBJECT
    });
    assert.equal(status, 200);
    assert.equal(body.result, 'ok');
    assert.equal(body.check_id, null);
    assert.equal(body.error_type, null);
  });
});

test('Math: sustitución válida cuando la referencia usa fórmula directa → ok', async () => {
  installDbMock();
  mockAnthropicResponse('RESULTADO: OK');

  await withServer(async (base) => {
    const { status, body } = await binaryCheck(base, {
      prompt_text:          'Calculá ∫ 2x dx',
      user_answer_text:     'Sea u = x², du = 2x dx → ∫ du = u + C = x² + C',
      expected_answer_text: '∫ 2x dx = x² + C  (regla de la potencia)',
      subject:              MATH_SUBJECT
    });
    assert.equal(status, 200);
    assert.equal(body.result, 'ok');
    assert.equal(body.check_id, null);
  });
});

test('Math: respuesta incompleta matemáticamente válida → ok', async () => {
  installDbMock();
  mockAnthropicResponse('RESULTADO: OK');

  await withServer(async (base) => {
    const { status, body } = await binaryCheck(base, {
      prompt_text:          INTEGRAL_EXERCISE,
      user_answer_text:     'Integración por partes: u = x, dv = eˣ dx',
      expected_answer_text: INTEGRAL_EXPECTED,
      subject:              MATH_SUBJECT
    });
    assert.equal(status, 200);
    assert.equal(body.result, 'ok');
    assert.equal(body.check_id, null);
  });
});

test('Math: notación ambigua pero razonablemente correcta → ok', async () => {
  installDbMock();
  mockAnthropicResponse('RESULTADO: OK');

  await withServer(async (base) => {
    const { status, body } = await binaryCheck(base, {
      prompt_text:          'Resolvé dy/dx = y',
      user_answer_text:     'y = Ce^x  (separando variables)',
      expected_answer_text: 'dy/y = dx → ln|y| = x + C₁ → y = Ae^x',
      subject:              MATH_SUBJECT
    });
    assert.equal(status, 200);
    assert.equal(body.result, 'ok');
    assert.equal(body.check_id, null);
  });
});

test('Math: error algebraico claro → error con log', async () => {
  const logged = [];
  installDbMock({ captureLog: (entry) => logged.push(entry) });
  mockAnthropicResponse(
    'RESULTADO: ERROR\nERROR_TYPE: conceptual\nERROR_LABEL: signo incorrecto en expansión'
  );

  await withServer(async (base) => {
    const { status, body } = await binaryCheck(base, {
      prompt_text:          'Expandí (a + b)²',
      user_answer_text:     '(a + b)² = a² - 2ab + b²',
      expected_answer_text: '(a + b)² = a² + 2ab + b²',
      subject:              MATH_SUBJECT
    });
    assert.equal(status, 200);
    assert.equal(body.result, 'error');
    assert.ok(body.check_id != null, 'should have check_id');
    assert.equal(body.error_type, 'conceptual');
    assert.equal(body.error_label, 'signo incorrecto en expansión');
    assert.equal(logged.length, 1, 'should insert one binary_check_log row');
  });
});

test('Math: cambio injustificado de integrando → error con log', async () => {
  const logged = [];
  installDbMock({ captureLog: (entry) => logged.push(entry) });
  mockAnthropicResponse(
    'RESULTADO: ERROR\nERROR_TYPE: conceptual\nERROR_LABEL: integrando modificado sin justificación'
  );

  await withServer(async (base) => {
    const { status, body } = await binaryCheck(base, {
      prompt_text:          'Calculá ∫ sin(x) dx',
      user_answer_text:     '∫ cos(x) dx = sin(x) + C',
      expected_answer_text: '∫ sin(x) dx = -cos(x) + C',
      subject:              MATH_SUBJECT
    });
    assert.equal(status, 200);
    assert.equal(body.result, 'error');
    assert.ok(body.check_id != null);
    assert.equal(body.error_type, 'conceptual');
    assert.equal(logged.length, 1);
  });
});

test('Math: respuesta malformada del modelo → ok sin check_id penalizable', async () => {
  const logged = [];
  installDbMock({ captureLog: (entry) => logged.push(entry) });
  // Completely malformed — no RESULTADO line
  mockAnthropicResponse('Lo siento, no puedo evaluar esto en este momento.');

  await withServer(async (base) => {
    const { status, body } = await binaryCheck(base, {
      prompt_text:          INTEGRAL_EXERCISE,
      user_answer_text:     'x·eˣ - eˣ + C',
      expected_answer_text: INTEGRAL_EXPECTED,
      subject:              MATH_SUBJECT
    });
    assert.equal(status, 200);
    assert.equal(body.result, 'ok');
    assert.equal(body.check_id, null, 'must not have check_id on format fallback');
    assert.equal(logged.length, 0, 'must not insert binary_check_log on format fallback');
  });
});

// ─── SQL regression tests ──────────────────────────────────────────────────────

test('SQL: query claramente inválida → error', async () => {
  const logged = [];
  installDbMock({ captureLog: (entry) => logged.push(entry) });
  mockAnthropicResponse(
    'RESULTADO: ERROR\nERROR_TYPE: conceptual\nERROR_LABEL: usa FUNCTION en lugar de PROCEDURE cursor'
  );

  await withServer(async (base) => {
    const { status, body } = await binaryCheck(base, {
      prompt_text:          SQL_EXERCISE,
      user_answer_text:     'CREATE FUNCTION get_emps RETURN SYS_REFCURSOR AS ...',
      expected_answer_text: SQL_EXPECTED,
      subject:              SQL_SUBJECT
    });
    assert.equal(status, 200);
    assert.equal(body.result, 'error');
    assert.ok(body.check_id != null, 'should log SQL error');
    assert.equal(body.error_type, 'conceptual');
    assert.equal(logged.length, 1);
  });
});

test('SQL: código incompleto encaminado → ok sin penalización', async () => {
  installDbMock();
  mockAnthropicResponse('RESULTADO: OK');

  await withServer(async (base) => {
    const { status, body } = await binaryCheck(base, {
      prompt_text:          SQL_EXERCISE,
      user_answer_text:     'DECLARE\n  CURSOR c IS SELECT nombre FROM empleados;\nBEGIN',
      expected_answer_text: SQL_EXPECTED,
      subject:              SQL_SUBJECT
    });
    assert.equal(status, 200);
    assert.equal(body.result, 'ok');
    assert.equal(body.check_id, null);
    assert.equal(body.error_type, null);
  });
});

// ─── Contract invariants ───────────────────────────────────────────────────────

test('contract: en OK no se inserta binary_check_log', async () => {
  const logged = [];
  installDbMock({ captureLog: (entry) => logged.push(entry) });
  mockAnthropicResponse('RESULTADO: OK');

  await withServer(async (base) => {
    await binaryCheck(base, {
      prompt_text:      'Cualquier ejercicio',
      user_answer_text: 'Respuesta correcta',
      subject:          MATH_SUBJECT
    });
    assert.equal(logged.length, 0);
  });
});

test('contract: error_label solo aparece cuando error_type es conceptual', async () => {
  installDbMock();
  mockAnthropicResponse('RESULTADO: ERROR\nERROR_TYPE: syntactic\nERROR_LABEL: espaciado raro');

  await withServer(async (base) => {
    const { body } = await binaryCheck(base, {
      prompt_text:      'Ejercicio',
      user_answer_text: 'respuesta',
      subject:          SQL_SUBJECT
    });
    assert.equal(body.result, 'error');
    assert.equal(body.error_type, 'syntactic');
    assert.equal(body.error_label, null, 'error_label must be null for syntactic errors');
  });
});

test('contract: RESULTADO: ambiguo (ni OK ni ERROR) → ok sin log', async () => {
  const logged = [];
  installDbMock({ captureLog: (entry) => logged.push(entry) });
  mockAnthropicResponse('RESULTADO: MAYBE\nERROR_TYPE: conceptual');

  await withServer(async (base) => {
    const { body } = await binaryCheck(base, {
      prompt_text:      'Ejercicio',
      user_answer_text: 'respuesta',
      subject:          MATH_SUBJECT
    });
    assert.equal(body.result, 'ok');
    assert.equal(body.check_id, null);
    assert.equal(logged.length, 0);
  });
});

// ─── Subject alias detection (pure unit tests — no HTTP, no rate limit) ────────
// detectCheckMode is a pure function; we test it directly to avoid consuming
// rate-limit budget with 20+ HTTP requests.

const MATH_ALIAS_CASES = [
  // Accented variants fixed by NFD normalization
  ['cálculo',               'math'],
  ['Cálculo 2',             'math'],
  ['álgebra',               'math'],
  ['Álgebra Lineal',        'math'],
  ['análisis',              'math'],
  ['Análisis Matemático 1', 'math'],
  // Plain ASCII equivalents
  ['calculo',               'math'],
  ['algebra',               'math'],
  ['analisis',              'math'],
  // Argentine curriculum shortcodes
  ['am1',  'math'], ['AM1',  'math'],
  ['am2',  'math'], ['AM2',  'math'],
  ['am3',  'math'], ['AM3',  'math'],
  ['am4',  'math'],
  ['edo',  'math'], ['EDO',  'math'],
  // Physics → math (uses equations; math-first prompt applies)
  ['física',         'math'],
  ['Física I',       'math'],
  ['fisica',         'math'],
  ['Física Teórica', 'math'],
  // Already-working — regression guard
  ['matemática',    'math'],
  ['integrales',    'math'],
  ['trigonometría', 'math'],
  // SQL stays SQL
  ['bases-de-datos', 'sql'],
  ['SQL',            'sql'],
  ['pl/sql',         'sql'],
  // Unknown stays generic
  ['',          'generic'],
  ['misc',      'generic'],
  ['Literatura','generic'],
];

for (const [subject, expected] of MATH_ALIAS_CASES) {
  test(`detectCheckMode("${subject}") → ${expected}`, () => {
    assert.equal(detectCheckMode(subject), expected);
  });
}

// ─── parseBinaryCheckOutput unit tests ────────────────────────────────────────

test('parse: RESULTADO: OK → ok parsedOk=true', () => {
  const r = parseBinaryCheckOutput('RESULTADO: OK');
  assert.equal(r.result, 'ok');
  assert.equal(r.parsedOk, true);
  assert.equal(r.errorType, null);
});

test('parse: sin RESULTADO → ok parsedOk=false (safe fallback)', () => {
  const r = parseBinaryCheckOutput('Lo siento, no puedo evaluar esto.');
  assert.equal(r.result, 'ok');
  assert.equal(r.parsedOk, false);
});

test('parse: RESULTADO: MAYBE → ok parsedOk=false (safe fallback)', () => {
  const r = parseBinaryCheckOutput('RESULTADO: MAYBE');
  assert.equal(r.result, 'ok');
  assert.equal(r.parsedOk, false);
});

test('parse: RESULTADO: ERROR conceptual → error parsedOk=true con label', () => {
  const r = parseBinaryCheckOutput(
    'RESULTADO: ERROR\nERROR_TYPE: conceptual\nERROR_LABEL: signo incorrecto'
  );
  assert.equal(r.result, 'error');
  assert.equal(r.parsedOk, true);
  assert.equal(r.errorType, 'conceptual');
  assert.equal(r.errorLabel, 'signo incorrecto');
});

test('parse: RESULTADO: ERROR syntactic → errorLabel null', () => {
  const r = parseBinaryCheckOutput(
    'RESULTADO: ERROR\nERROR_TYPE: syntactic\nERROR_LABEL: espaciado raro'
  );
  assert.equal(r.result, 'error');
  assert.equal(r.errorType, 'syntactic');
  assert.equal(r.errorLabel, null, 'syntactic errors must never expose a label');
});

test('parse: RESULTADO: ERROR sin ERROR_TYPE → unknown, errorLabel null', () => {
  const r = parseBinaryCheckOutput('RESULTADO: ERROR');
  assert.equal(r.result, 'error');
  assert.equal(r.errorType, 'unknown');
  assert.equal(r.errorLabel, null);
  assert.equal(r.parsedOk, true);
});

// ─── Scheduler downstream safety (integration) ────────────────────────────────
// binary_check_log rows with error_type != 'conceptual' OR error_label IS NULL
// are excluded by the scheduler query:
//   WHERE id = ANY($1) AND error_type = 'conceptual' AND error_label IS NOT NULL
// These tests confirm the INSERT params match that contract.
// Use a high user ID (9901/9902) to avoid exhausting the shared rate-limit pool.

async function withSchedulerServer(userId, runTest) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId }; next(); });
  app.use(evaluateRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await runTest(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('scheduler safety: syntactic error → error_label null en INSERT', async () => {
  const logged = [];
  installDbMock({ captureLog: (entry) => logged.push(entry) });
  mockAnthropicResponse('RESULTADO: ERROR\nERROR_TYPE: syntactic\nERROR_LABEL: espaciado raro');

  await withSchedulerServer(9901, async (base) => {
    const { body } = await binaryCheck(base, {
      prompt_text:      'Ejercicio SQL',
      user_answer_text: 'SELECT*FROM t',
      subject:          SQL_SUBJECT
    });
    assert.equal(body.result, 'error');
    assert.equal(body.error_type, 'syntactic');
    assert.equal(body.error_label, null);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].params[5], null, 'binary_check_log.error_label debe ser null para syntactic');
  });
});

test('scheduler safety: unknown error_type → error_label null en INSERT', async () => {
  const logged = [];
  installDbMock({ captureLog: (entry) => logged.push(entry) });
  mockAnthropicResponse('RESULTADO: ERROR');

  await withSchedulerServer(9902, async (base) => {
    const { body } = await binaryCheck(base, {
      prompt_text:      'Ejercicio',
      user_answer_text: 'respuesta',
      subject:          SQL_SUBJECT
    });
    assert.equal(body.result, 'error');
    assert.equal(body.error_type, 'unknown');
    assert.equal(body.error_label, null);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].params[5], null, 'binary_check_log.error_label debe ser null para unknown');
  });
});
