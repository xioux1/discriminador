const EVALUATE_ENDPOINT = '/evaluate';
const DECISION_ENDPOINT = '/decision';

// --- Tab navigation ---

(function initTabs() {
  const tabs       = document.querySelectorAll('.tab-btn');
  const tabEval    = document.querySelector('#tab-evaluate');
  const tabHistory = document.querySelector('#tab-history');
  const tabStudy   = document.querySelector('#tab-study');
  let historyLoaded = false;
  let studyLoaded   = false;

  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;

      tabEval.classList.add('hidden');
      tabHistory.classList.add('hidden');
      tabStudy.classList.add('hidden');

      if (tab === 'evaluate') {
        tabEval.classList.remove('hidden');
      } else if (tab === 'history') {
        tabHistory.classList.remove('hidden');
        if (!historyLoaded) { historyLoaded = true; loadHistoryOverview(); }
      } else if (tab === 'study') {
        tabStudy.classList.remove('hidden');
        if (!studyLoaded) { studyLoaded = true; initStudyTab(); }
      }
    });
  });
})();

const DIM_LABELS_OVERVIEW = {
  core_idea: 'Idea central',
  conceptual_accuracy: 'Precisión conceptual',
  completeness: 'Completitud'
};

async function loadHistoryOverview() {
  const loading = document.querySelector('#history-loading');
  const content = document.querySelector('#history-content');
  loading.classList.remove('hidden');
  content.innerHTML = '';

  try {
    const res = await fetch('/stats/overview');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { subjects } = await res.json();
    loading.classList.add('hidden');

    if (!subjects || subjects.length === 0) {
      content.innerHTML = '<p style="padding:16px;color:#888">Todavía no hay evaluaciones registradas.</p>';
      return;
    }

    subjects.forEach((subj) => {
      const section = document.createElement('div');
      section.className = 'history-subject';

      const passRatePct = Math.round(subj.pass_rate * 100);
      const header = document.createElement('div');
      header.className = 'history-subject-header';
      header.innerHTML = `
        <span>${subj.subject} <small style="font-weight:400;color:#666">${subj.total_questions} pregunta${subj.total_questions !== 1 ? 's' : ''}</small></span>
        <span class="stat-pill ${passRatePct >= 60 ? 'pass' : 'fail'}" style="margin:0">${passRatePct}% PASS</span>`;

      const body = document.createElement('div');
      body.className = 'history-subject-body';

      subj.questions.forEach((q) => {
        const row = document.createElement('div');
        row.className = 'history-question-row';
        const qPassPct = Math.round(q.pass_rate * 100);
        const weakLabel = q.weakest_dimension ? DIM_LABELS_OVERVIEW[q.weakest_dimension] || q.weakest_dimension : null;
        row.innerHTML = `
          <span class="history-question-prompt">${q.prompt_text.length > 120 ? q.prompt_text.slice(0, 120) + '…' : q.prompt_text}</span>
          <span class="history-question-meta">
            <span class="grade-badge ${q.last_grade}">${q.last_grade.toUpperCase()}</span>
            <span class="stat-pill ${qPassPct >= 60 ? 'pass' : 'fail'}" style="margin:0;font-size:0.75rem">${qPassPct}% · ${q.total}x</span>
            ${weakLabel ? `<span style="font-size:0.75rem;color:#888">débil: ${weakLabel}</span>` : ''}
          </span>`;

        // Expandable detail
        const detail = document.createElement('div');
        detail.className = 'history-question-detail';
        detail.innerHTML = '<p style="color:#888;font-size:0.85rem">Cargando...</p>';

        row.addEventListener('click', async () => {
          const isOpen = detail.classList.toggle('open');
          if (isOpen && detail.innerHTML.includes('Cargando')) {
            try {
              const r = await fetch(`/stats/question?prompt=${encodeURIComponent(q.prompt_text)}`);
              const data = await r.json();
              detail.innerHTML = '';
              renderQuestionStats(data);
              // Move rendered stats nodes into detail
              const statsEl = document.querySelector('#question-stats');
              const clone = document.querySelector('#stats-body').cloneNode(true);
              clone.classList.remove('hidden');
              clone.removeAttribute('id');
              detail.innerHTML = '';

              // Rebuild inline stats for the detail panel
              const summaryDiv = document.createElement('div');
              summaryDiv.className = 'stats-summary';
              const pct = Math.round(data.pass_rate * 100);
              [
                { label: `${data.total} evaluacion${data.total !== 1 ? 'es' : ''}`, cls: '' },
                { label: `${pct}% PASS`, cls: pct >= 60 ? 'pass' : 'fail' }
              ].forEach(({ label, cls }) => {
                const s = document.createElement('span');
                s.className = `stat-pill${cls ? ' ' + cls : ''}`;
                s.textContent = label;
                summaryDiv.appendChild(s);
              });
              detail.appendChild(summaryDiv);

              if (data.history) {
                const histTitle = document.createElement('p');
                histTitle.className = 'stats-section-title';
                histTitle.textContent = 'Últimas evaluaciones';
                detail.appendChild(histTitle);
                data.history.forEach((item) => {
                  const hrow = document.createElement('div');
                  hrow.className = 'stats-history-item';
                  const date = item.decided_at ? new Date(item.decided_at).toLocaleDateString('es-AR') : '';
                  hrow.innerHTML = `<span class="grade-badge ${item.final_grade}">${item.final_grade.toUpperCase()}</span>
                    <span style="color:#888;font-size:0.8rem">${date}</span>
                    ${item.justification ? `<span style="color:#555;font-size:0.82rem">${item.justification}</span>` : ''}
                    ${item.correction_reason ? `<span style="color:#888;font-size:0.8rem">[corrección: ${item.correction_reason}]</span>` : ''}`;
                  detail.appendChild(hrow);
                });
              }
            } catch (_e) {
              detail.innerHTML = '<p style="color:#a40000;font-size:0.85rem">Error al cargar el detalle.</p>';
            }
          }
        });

        body.appendChild(row);
        body.appendChild(detail);
      });

      header.addEventListener('click', () => body.classList.toggle('open'));
      section.appendChild(header);
      section.appendChild(body);
      content.appendChild(section);
    });
  } catch (err) {
    loading.classList.add('hidden');
    content.innerHTML = `<p style="padding:16px;color:#a40000">Error al cargar historial: ${err.message}</p>`;
  }
}

// --- End Tab navigation ---

const form = document.querySelector('#evaluation-form');
const evaluateBtn = document.querySelector('#evaluate-btn');
const resultCard = document.querySelector('#result-card');
const resultLoading = document.querySelector('#result-loading');
const resultContent = document.querySelector('#result-content');
const feedbackEl = document.querySelector('#save-feedback');
const formFeedbackEl = document.querySelector('#form-feedback');
const fillExpectedBtn = document.querySelector('#fill-expected-btn');
const subjectsDatalist = document.querySelector('#subjects-list');

// --- Subject datalist ---
async function loadSubjects() {
  try {
    const res = await fetch('/subjects');
    if (!res.ok) return;
    const { subjects } = await res.json();
    subjectsDatalist.innerHTML = '';
    subjects.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s;
      subjectsDatalist.appendChild(opt);
    });
  } catch (_e) { /* non-blocking */ }
}
loadSubjects();

// --- Expected answer lookup ---
let _expectedAnswerCache = null;
let _lookupDebounce = null;

function clearExpectedHint() {
  _expectedAnswerCache = null;
  fillExpectedBtn.classList.add('hidden');
}

async function lookupExpectedAnswer(promptText) {
  if (promptText.trim().length < 10) {
    clearExpectedHint();
    return;
  }
  try {
    const res = await fetch(`/expected-answer?prompt=${encodeURIComponent(promptText.trim())}`);
    if (!res.ok) { clearExpectedHint(); return; }
    const data = await res.json();
    if (data.found && data.expected_answer_text) {
      _expectedAnswerCache = data.expected_answer_text;
      fillExpectedBtn.classList.remove('hidden');
    } else {
      clearExpectedHint();
    }
  } catch (_e) {
    clearExpectedHint();
  }
}

document.querySelector('#prompt_text').addEventListener('input', (e) => {
  clearTimeout(_lookupDebounce);
  clearExpectedHint();
  formFeedbackEl.textContent = '';
  _lookupDebounce = setTimeout(() => lookupExpectedAnswer(e.target.value), 800);
});

fillExpectedBtn.addEventListener('click', () => {
  if (_expectedAnswerCache) {
    document.querySelector('#expected_answer_text').value = _expectedAnswerCache;
    fillExpectedBtn.classList.add('hidden');
  }
});

// --- Reset form after decision ---
function resetForm() {
  const subject = form.subject.value;
  form.reset();
  form.subject.value = subject;
  clearExpectedHint();
  resultCard.classList.add('hidden');
  resultContent.classList.add('hidden');
  resultLoading.classList.add('hidden');
  uiState.lastRequest = null;
  uiState.lastResult = null;
}

const uiState = {
  evaluating: false,
  savingDecision: false,
  lastRequest: null,
  lastResult: null,
  manualQueue: [],
};

const minRules = {
  prompt_text: 10,
  user_answer_text: 5,
  expected_answer_text: 10,
};

const errorMessages = {
  prompt_text: 'La consigna es obligatoria (mínimo 10 caracteres).',
  user_answer_text: 'La respuesta del usuario es obligatoria (mínimo 5 caracteres).',
  expected_answer_text: 'La respuesta esperada es obligatoria (mínimo 10 caracteres).',
  subject: 'La materia debe tener entre 1 y 60 caracteres.',
};

function normalize(value) {
  return value.trim();
}

function setFieldError(field, message = '') {
  const node = document.querySelector(`[data-error-for="${field}"]`);
  if (node) {
    node.textContent = message;
  }
}

function validate(payload) {
  const errors = {};

  Object.entries(minRules).forEach(([field, min]) => {
    if (normalize(payload[field]).length < min) {
      errors[field] = errorMessages[field];
    }
  });

  if (payload.subject && (normalize(payload.subject).length < 1 || normalize(payload.subject).length > 60)) {
    errors.subject = errorMessages.subject;
  }

  return errors;
}

function clearErrors() {
  ['prompt_text', 'user_answer_text', 'expected_answer_text', 'subject'].forEach((key) => setFieldError(key, ''));
}

function setControlsDisabled(disabled) {
  const controls = form.querySelectorAll('textarea, input, button');
  controls.forEach((el) => {
    el.disabled = disabled;
  });

  resultContent.querySelectorAll('button, textarea').forEach((el) => {
    el.disabled = disabled || uiState.savingDecision;
  });
}

function setDecisionButtonsDisabled(disabled) {
  resultContent.querySelectorAll('button').forEach((el) => {
    el.disabled = disabled;
  });
}

function setFeedback(message, type = '') {
  feedbackEl.textContent = message;
  feedbackEl.className = 'feedback';
  if (type) {
    feedbackEl.classList.add(type);
  }
}

function normalizeSuggestedGrade(grade) {
  return String(grade || '').toUpperCase();
}

function getSuggestedGradeLabel(grade) {
  const normalized = normalizeSuggestedGrade(grade);
  if (normalized === 'REVIEW') {
    return 'requiere validación docente';
  }

  return normalized;
}

function enqueueManualCase(result) {
  if (!result?.evaluation_id) {
    return { position: null, size: uiState.manualQueue.length };
  }

  const priorityByGrade = {
    REVIEW: 0,
    FAIL: 1,
    PASS: 2,
  };
  const normalizedGrade = normalizeSuggestedGrade(result.suggested_grade);
  const existingIndex = uiState.manualQueue.findIndex((item) => item.evaluation_id === result.evaluation_id);

  const queueItem = {
    evaluation_id: result.evaluation_id,
    suggested_grade: normalizedGrade,
    priority: priorityByGrade[normalizedGrade] ?? 3,
    created_at: Date.now(),
  };

  if (existingIndex >= 0) {
    uiState.manualQueue[existingIndex] = queueItem;
  } else {
    uiState.manualQueue.push(queueItem);
  }

  uiState.manualQueue.sort((a, b) => a.priority - b.priority || a.created_at - b.created_at);
  return {
    size: uiState.manualQueue.length,
    position: uiState.manualQueue.findIndex((item) => item.evaluation_id === result.evaluation_id) + 1,
  };
}

function removeManualCase(evaluationId) {
  if (!evaluationId) {
    return;
  }

  uiState.manualQueue = uiState.manualQueue.filter((item) => item.evaluation_id !== evaluationId);
}

function renderResult(result) {
  document.querySelector('#suggested-grade').textContent = getSuggestedGradeLabel(result.suggested_grade);
  document.querySelector('#overall-score').textContent = Number(result.overall_score).toFixed(2);
  document.querySelector('#model-confidence').textContent = Number(result.model_confidence).toFixed(2);
  document.querySelector('#justification-short').textContent = result.justification_short;

  const dimensionsList = document.querySelector('#dimensions-list');
  dimensionsList.innerHTML = '';

  Object.entries(result.dimensions || {}).forEach(([dimension, value]) => {
    const li = document.createElement('li');
    li.textContent = `${dimension}: ${value}`;
    dimensionsList.appendChild(li);
  });

  // Render missing concepts if present
  let missingEl = document.querySelector('#missing-concepts');
  if (!missingEl) {
    missingEl = document.createElement('p');
    missingEl.id = 'missing-concepts';
    document.querySelector('#justification-short').parentElement.after(missingEl);
  }
  const concepts = result.missing_concepts;
  if (concepts && concepts.length > 0) {
    missingEl.innerHTML = `<strong>Conceptos ausentes:</strong> ${concepts.map((c) => `<span class="concept-tag">${c}</span>`).join(' ')}`;
    missingEl.classList.remove('hidden');
  } else {
    missingEl.textContent = '';
    missingEl.classList.add('hidden');
  }

  const socraticTrigger = document.querySelector('#socratic-trigger-btn');
  const socraticSection = document.querySelector('#socratic-section');
  const socraticSubmit = document.querySelector('#socratic-submit-btn');
  socraticSection.classList.add('hidden');
  socraticSubmit.classList.remove('hidden');
  document.querySelector('#socratic-questions').innerHTML = '';

  const grade = normalizeSuggestedGrade(result.suggested_grade);
  if (grade === 'REVIEW') {
    socraticTrigger.textContent = 'Responder preguntas de profundización';
    socraticTrigger.dataset.label = 'Responder preguntas de profundización';
    socraticTrigger.classList.remove('hidden');
  } else if (grade === 'FAIL') {
    socraticTrigger.textContent = 'Entender el error';
    socraticTrigger.dataset.label = 'Entender el error';
    socraticTrigger.classList.remove('hidden');
  } else {
    socraticTrigger.classList.add('hidden');
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let data;
  try {
    data = await response.json();
  } catch (_e) {
    data = {};
  }

  if (!response.ok) {
    const reason = data.message || `Error HTTP ${response.status}`;
    throw new Error(reason);
  }

  return data;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (uiState.evaluating) {
    return;
  }

  clearErrors();
  setFeedback('');

  const payload = {
    prompt_text: normalize(form.prompt_text.value),
    user_answer_text: normalize(form.user_answer_text.value),
    expected_answer_text: normalize(form.expected_answer_text.value),
    subject: normalize(form.subject.value),
  };

  if (!payload.subject) {
    delete payload.subject;
  }

  const errors = validate(payload);
  if (Object.keys(errors).length > 0) {
    Object.entries(errors).forEach(([field, msg]) => setFieldError(field, msg));
    return;
  }

  uiState.evaluating = true;
  setControlsDisabled(true);
  evaluateBtn.textContent = 'Evaluando...';
  resultCard.classList.remove('hidden');
  resultLoading.classList.remove('hidden');
  resultContent.classList.add('hidden');

  try {
    const result = await postJson(EVALUATE_ENDPOINT, payload);
    uiState.lastRequest = payload;
    uiState.lastResult = result;
    const manualQueueStatus = enqueueManualCase(result);

    renderResult(result);
    loadQuestionStats(payload.prompt_text);
    resultLoading.classList.add('hidden');
    resultContent.classList.remove('hidden');
    const normalizedSuggestedGrade = normalizeSuggestedGrade(result.suggested_grade);
    const reviewHint = normalizedSuggestedGrade === 'REVIEW'
      ? ` Caso priorizado en cola manual (#${manualQueueStatus.position} de ${manualQueueStatus.size}).`
      : '';
    setFeedback(`Evaluación lista. Ahora firma una decisión final.${reviewHint}`);
  } catch (error) {
    resultLoading.classList.add('hidden');
    resultContent.classList.add('hidden');
    setFeedback(`No se pudo evaluar: ${error.message}`, 'error');
  } finally {
    uiState.evaluating = false;
    setControlsDisabled(false);
    evaluateBtn.textContent = 'Evaluar';
  }
});

// --- Question stats ---

const TREND_LABELS = {
  improving: 'Mejorando',
  declining: 'Bajando',
  stable: 'Estable',
  insufficient_data: ''
};

const DIM_LABELS = {
  core_idea: 'Idea central',
  conceptual_accuracy: 'Precisión conceptual',
  completeness: 'Completitud',
  memorization_risk: 'Riesgo memorización'
};

async function loadQuestionStats(promptText) {
  const statsEl = document.querySelector('#question-stats');
  statsEl.classList.add('hidden');
  document.querySelector('#stats-body').classList.add('hidden');
  document.querySelector('#stats-toggle-icon').textContent = '▼';

  if (!promptText || promptText.trim().length < 10) return;

  try {
    const res = await fetch(`/stats/question?prompt=${encodeURIComponent(promptText.trim())}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.total || data.total === 0) return;

    renderQuestionStats(data);
    statsEl.classList.remove('hidden');
  } catch (_e) { /* non-blocking */ }
}

function renderQuestionStats(data) {
  // Summary pills
  const summary = document.querySelector('#stats-summary');
  summary.innerHTML = '';
  const passRatePct = Math.round(data.pass_rate * 100);
  const trendLabel = TREND_LABELS[data.trend] || '';

  const pills = [
    { label: `${data.total} evaluacion${data.total !== 1 ? 'es' : ''}`, cls: '' },
    { label: `${passRatePct}% PASS`, cls: data.pass_rate >= 0.6 ? 'pass' : 'fail' },
    ...(trendLabel ? [{ label: trendLabel, cls: `trend-${data.trend}` }] : [])
  ];
  pills.forEach(({ label, cls }) => {
    const span = document.createElement('span');
    span.className = `stat-pill${cls ? ' ' + cls : ''}`;
    span.textContent = label;
    summary.appendChild(span);
  });

  // Dimension bars (exclude memorization_risk, sort weakest first)
  const dimEl = document.querySelector('#stats-dimensions');
  dimEl.innerHTML = '';
  const dims = (data.dimension_stats || []).filter((d) => d.dimension !== 'memorization_risk');
  if (dims.length > 0) {
    const title = document.createElement('p');
    title.className = 'stats-section-title';
    title.textContent = 'Dimensiones';
    dimEl.appendChild(title);
    dims.forEach(({ dimension, avg_score, fail_count }) => {
      const pct = Math.round(avg_score * 100);
      const colorCls = avg_score < 0.4 ? 'weak' : avg_score < 0.7 ? 'mid' : '';
      const row = document.createElement('div');
      row.className = 'dimension-bar-row';
      row.innerHTML = `
        <span class="dimension-bar-label">${DIM_LABELS[dimension] || dimension}${fail_count > 0 ? ` <small>(${fail_count}✗)</small>` : ''}</span>
        <div class="dimension-bar-track"><div class="dimension-bar-fill${colorCls ? ' ' + colorCls : ''}" style="width:${pct}%"></div></div>
        <span>${pct}%</span>`;
      dimEl.appendChild(row);
    });
  }

  // Observations (LLM + user corrections)
  const errEl = document.querySelector('#stats-errors');
  errEl.innerHTML = '';
  if (data.observations && data.observations.length > 0) {
    const title = document.createElement('p');
    title.className = 'stats-section-title';
    title.textContent = 'Observaciones';
    errEl.appendChild(title);
    data.observations.forEach((obs) => {
      const row = document.createElement('div');
      row.className = 'stats-history-item';
      const badge = `<span class="grade-badge ${obs.grade}">${obs.grade.toUpperCase()}</span>`;
      const sourceTag = obs.source === 'user'
        ? '<span style="font-size:0.75rem;color:#888">[corrección]</span>'
        : '<span style="font-size:0.75rem;color:#888">[LLM]</span>';
      row.innerHTML = `${badge} ${sourceTag} <span style="color:#333">${obs.text}</span>`;
      errEl.appendChild(row);
    });
  }

  // History
  const histEl = document.querySelector('#stats-history');
  histEl.innerHTML = '';
  if (data.history && data.history.length > 0) {
    const title = document.createElement('p');
    title.className = 'stats-section-title';
    title.textContent = 'Últimas evaluaciones';
    histEl.appendChild(title);
    data.history.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'stats-history-item';
      const date = item.decided_at ? new Date(item.decided_at).toLocaleDateString('es-AR') : '';
      row.innerHTML = `<span class="grade-badge ${item.final_grade}">${item.final_grade.toUpperCase()}</span>
        <span style="color:#888;font-size:0.8rem">${date}</span>
        ${item.correction_reason ? `<span style="color:#555">${item.correction_reason}</span>` : ''}`;
      histEl.appendChild(row);
    });
  }
}

document.querySelector('#stats-toggle').addEventListener('click', () => {
  const body = document.querySelector('#stats-body');
  const icon = document.querySelector('#stats-toggle-icon');
  const hidden = body.classList.toggle('hidden');
  icon.textContent = hidden ? '▼' : '▲';
});

// --- End Question stats ---

// --- Socratic questions ---

(function initSocratic() {
  const triggerBtn = document.querySelector('#socratic-trigger-btn');
  const section = document.querySelector('#socratic-section');
  const questionsContainer = document.querySelector('#socratic-questions');
  const submitBtn = document.querySelector('#socratic-submit-btn');

  function getSocraticMode() {
    return normalizeSuggestedGrade(uiState.lastResult?.suggested_grade) === 'FAIL' ? 'fail' : 'review';
  }

  triggerBtn.addEventListener('click', async () => {
    if (!uiState.lastResult || !uiState.lastRequest) return;

    const mode = getSocraticMode();
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Generando preguntas...';

    try {
      const { questions } = await postJson('/socratic/questions', {
        prompt_text: uiState.lastRequest.prompt_text,
        user_answer_text: uiState.lastRequest.user_answer_text,
        expected_answer_text: uiState.lastRequest.expected_answer_text,
        subject: uiState.lastRequest.subject || '',
        dimensions: uiState.lastResult.dimensions,
        justification: uiState.lastResult.justification_short,
        mode
      });

      questionsContainer.innerHTML = '';
      questions.forEach((q, i) => {
        const block = document.createElement('div');
        block.className = 'socratic-question-block';

        const header = document.createElement('div');
        header.className = 'field-header';

        const label = document.createElement('label');
        label.setAttribute('for', `socratic-answer-${i}`);
        label.textContent = q;

        const dictBtn = document.createElement('button');
        dictBtn.type = 'button';
        dictBtn.className = 'dictation-btn';
        dictBtn.textContent = 'Dictar';
        dictBtn.hidden = true;

        header.appendChild(label);
        header.appendChild(dictBtn);

        const textarea = document.createElement('textarea');
        textarea.id = `socratic-answer-${i}`;
        textarea.rows = 2;
        textarea.dataset.question = q;

        block.appendChild(header);
        block.appendChild(textarea);
        questionsContainer.appendChild(block);

        attachDictation(dictBtn, textarea, 'Dictar');
      });

      submitBtn.textContent = mode === 'fail' ? 'Ver feedback del error' : 'Re-evaluar con mis respuestas';
      submitBtn.dataset.mode = mode;
      section.classList.remove('hidden');
      triggerBtn.classList.add('hidden');
    } catch (err) {
      setFeedback(`Error al generar preguntas: ${err.message}`, 'error');
      triggerBtn.disabled = false;
      triggerBtn.textContent = triggerBtn.dataset.label || 'Responder preguntas';
    }
  });

  submitBtn.addEventListener('click', async () => {
    const answerTextareas = questionsContainer.querySelectorAll('textarea');
    const socratic_qa = [];

    for (const ta of answerTextareas) {
      if (ta.value.trim().length < 3) {
        setFeedback('Respondé todas las preguntas antes de continuar.', 'error');
        return;
      }
      socratic_qa.push({ question: ta.dataset.question, answer: ta.value.trim() });
    }

    const mode = submitBtn.dataset.mode || 'review';
    submitBtn.disabled = true;
    submitBtn.textContent = mode === 'fail' ? 'Procesando...' : 'Re-evaluando...';

    try {
      if (mode === 'fail') {
        const { error_summary, correct_concept } = await postJson('/socratic/feedback', {
          ...uiState.lastRequest,
          socratic_qa
        });

        questionsContainer.innerHTML = '';
        const feedbackBlock = document.createElement('div');
        feedbackBlock.className = 'socratic-feedback';
        feedbackBlock.innerHTML = `<p><strong>Lo que faltó:</strong> ${error_summary}</p><p><strong>Concepto correcto:</strong> ${correct_concept}</p>`;
        questionsContainer.appendChild(feedbackBlock);
        submitBtn.classList.add('hidden');
        setFeedback('Revisá el feedback y luego firma tu decisión.');
      } else {
        const reeval = await postJson('/socratic/evaluate', {
          ...uiState.lastRequest,
          evaluation_id: uiState.lastResult.evaluation_id,
          socratic_qa
        });

        uiState.lastResult = { ...uiState.lastResult, ...reeval };
        document.querySelector('#suggested-grade').textContent = getSuggestedGradeLabel(reeval.suggested_grade);
        document.querySelector('#justification-short').textContent = reeval.justification;
        section.classList.add('hidden');
        setFeedback('Re-evaluación completada. Ahora firma una decisión final.');
      }
    } catch (err) {
      setFeedback(`Error: ${err.message}`, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = mode === 'fail' ? 'Ver feedback del error' : 'Re-evaluar con mis respuestas';
    }
  });
})();

// --- End Socratic ---

// --- Dictation (MediaRecorder + Whisper) ---

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Attach dictation (record + Whisper transcribe) to a button/textarea pair.
 * btn: the trigger button element
 * textarea: the target textarea element
 * labelIdle: button text when idle
 */
function attachDictation(btn, textarea, labelIdle = 'Dictar', subjectOverride = null) {
  if (!window.MediaRecorder || !navigator.mediaDevices) return;

  btn.hidden = false;

  let mediaRecorder = null;
  let audioChunks = [];
  let stream = null;

  async function startRecording() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_err) {
      setFeedback('No se pudo acceder al micrófono.', 'error');
      return;
    }

    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(audioChunks, { type: mimeType });

      btn.textContent = 'Transcribiendo...';
      btn.disabled = true;

      try {
        const base64 = await blobToBase64(blob);
        const subject = subjectOverride ?? document.querySelector('#subject')?.value?.trim() ?? '';
        const response = await fetch('/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: base64, mime_type: mimeType, subject })
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.message || `Error HTTP ${response.status}`);
        }

        const { text } = await response.json();
        if (text) {
          const current = textarea.value;
          const separator = current && !current.endsWith(' ') ? ' ' : '';
          textarea.value = current + separator + text;
        }
      } catch (err) {
        setFeedback(`Error de transcripción: ${err.message}`, 'error');
      } finally {
        btn.textContent = labelIdle;
        btn.disabled = false;
        btn.classList.remove('recording');
      }
    };

    mediaRecorder.start();
    btn.textContent = 'Detener dictado';
    btn.classList.add('recording');
  }

  btn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    } else {
      startRecording();
    }
  });
}

// Attach to main answer field
attachDictation(
  document.querySelector('#dictation-btn'),
  document.querySelector('#user_answer_text'),
  'Dictar respuesta'
);

// --- End Dictation ---

resultContent.addEventListener('click', async (event) => {
  const action = event.target?.dataset?.action;
  if (!action || uiState.savingDecision || !uiState.lastResult || !uiState.lastRequest) {
    return;
  }

  const suggestion = uiState.lastResult.suggested_grade;
  const correctionReason = normalize(document.querySelector('#correction_reason').value);
  const normalizedSuggestion = normalizeSuggestedGrade(suggestion);

  if (action === 'accept' && normalizedSuggestion === 'REVIEW') {
    setFeedback('Las sugerencias en revisión requieren validación docente: usa corregir o marcar duda.', 'error');
    return;
  }

  const finalGradeByAction = {
    accept: suggestion,
    'correct-pass': 'PASS',
    'correct-fail': 'FAIL',
    uncertain: null,
  };

  const decisionPayload = {
    ...uiState.lastRequest,
    evaluation_id: uiState.lastResult?.evaluation_id,
    evaluation_result: uiState.lastResult,
    action,
    final_grade: finalGradeByAction[action],
    accepted_suggestion: action === 'accept',
    correction_reason: correctionReason || undefined,
  };

  uiState.savingDecision = true;
  setDecisionButtonsDisabled(true);
  setFeedback('Guardando decisión final...');

  try {
    await postJson(DECISION_ENDPOINT, decisionPayload);
    removeManualCase(uiState.lastResult?.evaluation_id);
    loadSubjects();
    resetForm();
    formFeedbackEl.textContent = 'Decisión guardada. Podés continuar con la siguiente.';
    formFeedbackEl.className = 'feedback success';
  } catch (error) {
    setFeedback(`Error al guardar la decisión: ${error.message}`, 'error');
  } finally {
    uiState.savingDecision = false;
    setDecisionButtonsDisabled(false);
  }
});

// ─── Study tab ────────────────────────────────────────────────────────────────

function initStudyTab() {
  loadStudyOverview();

  document.querySelector('#study-add-card-btn').addEventListener('click', () => {
    document.querySelector('#study-add-form').classList.remove('hidden');
  });
  document.querySelector('#card-cancel-btn').addEventListener('click', () => {
    document.querySelector('#study-add-form').classList.add('hidden');
  });
  document.querySelector('#card-save-btn').addEventListener('click', saveNewCard);
  document.querySelector('#study-start-btn').addEventListener('click', startStudySession);
  document.querySelector('#study-again-btn').addEventListener('click', () => {
    document.querySelector('#study-complete').classList.add('hidden');
    loadStudyOverview();
  });
}

async function loadStudyOverview() {
  const summary = document.querySelector('#study-queue-summary');
  const actions = document.querySelector('#study-overview-actions');
  summary.innerHTML = '<span style="color:#888">Cargando cola...</span>';
  actions.classList.add('hidden');

  try {
    const data = await getJson('/scheduler/session');
    const microCount = data.micro_cards?.length ?? 0;
    const cardCount  = data.cards?.length ?? 0;
    const total      = microCount + cardCount;

    if (total === 0) {
      summary.innerHTML = '<span style="color:#4a7;font-weight:600">Sin tarjetas para hoy. ¡Al día!</span>';
    } else {
      summary.innerHTML = `
        <span class="study-queue-count">${total}</span> tarjeta${total !== 1 ? 's' : ''} para hoy
        ${microCount > 0 ? `<span class="study-queue-detail">(${microCount} micro-concepto${microCount !== 1 ? 's' : ''})</span>` : ''}
      `;
    }
    actions.classList.remove('hidden');
  } catch (err) {
    summary.innerHTML = `<span style="color:#c00">Error al cargar la cola: ${err.message}</span>`;
  }
}

async function saveNewCard() {
  const subject  = document.querySelector('#card-subject').value.trim();
  const prompt   = document.querySelector('#card-prompt').value.trim();
  const expected = document.querySelector('#card-expected').value.trim();
  const feedback = document.querySelector('#card-save-feedback');

  if (!prompt || !expected) {
    feedback.textContent = 'La pregunta y la respuesta esperada son obligatorias.';
    feedback.style.color = '#c00';
    return;
  }

  try {
    await postJson('/scheduler/cards', { subject, prompt_text: prompt, expected_answer_text: expected });
    feedback.textContent = 'Tarjeta guardada.';
    feedback.style.color = '#4a7';
    document.querySelector('#card-prompt').value = '';
    document.querySelector('#card-expected').value = '';
    loadStudyOverview();
    setTimeout(() => {
      document.querySelector('#study-add-form').classList.add('hidden');
      feedback.textContent = '';
    }, 1500);
  } catch (err) {
    feedback.textContent = `Error: ${err.message}`;
    feedback.style.color = '#c00';
  }
}

// ─── Active session state ─────────────────────────────────────────────────────
const studyState = {
  queue: [],        // [{type:'card'|'micro', data:{...}}]
  index: 0,
  results: [],      // {grade, type, concept?}
  currentEvalResult: null
};

async function startStudySession() {
  const data = await getJson('/scheduler/session');
  const micros = (data.micro_cards ?? []).map((m) => ({ type: 'micro', data: m }));
  const cards  = (data.cards ?? []).map((c) => ({ type: 'card', data: c }));

  studyState.queue   = [...micros, ...cards];
  studyState.index   = 0;
  studyState.results = [];

  if (studyState.queue.length === 0) {
    loadStudyOverview();
    return;
  }

  document.querySelector('#study-overview').classList.add('hidden');
  document.querySelector('#study-add-form').classList.add('hidden');
  document.querySelector('#study-complete').classList.add('hidden');
  document.querySelector('#study-session').classList.remove('hidden');

  showStudyCard();
}

function showStudyCard() {
  const item = studyState.queue[studyState.index];
  if (!item) { finishStudySession(); return; }

  const total   = studyState.queue.length;
  const current = studyState.index + 1;

  document.querySelector('#study-progress-text').textContent = `${current} / ${total}`;

  const badge = document.querySelector('#study-card-badge');
  const promptEl = document.querySelector('#study-card-prompt');

  if (item.type === 'micro') {
    badge.textContent = `Micro-concepto: ${item.data.concept}`;
    badge.classList.remove('hidden');
    promptEl.textContent = item.data.question;
  } else {
    badge.classList.add('hidden');
    const hasMicros = parseInt(item.data.active_micro_count) > 0;
    badge.textContent = hasMicros ? `⚠ Conceptos pendientes (${item.data.active_micro_count})` : '';
    if (hasMicros) badge.classList.remove('hidden');
    promptEl.textContent = item.data.prompt_text;
  }

  // Reset answer + result blocks
  document.querySelector('#study-answer-input').value = '';
  document.querySelector('#study-answer-block').classList.remove('hidden');
  document.querySelector('#study-result-block').classList.add('hidden');
  document.querySelector('#study-eval-btn').disabled = false;
  studyState.currentEvalResult = null;

  // Attach dictation to study textarea
  const dictBtn = document.querySelector('#study-dictation-btn');
  const textarea = document.querySelector('#study-answer-input');
  const subject = item.type === 'micro' ? item.data.parent_subject : item.data.subject;
  attachDictation(dictBtn, textarea, 'Dictar', subject);
}

document.querySelector('#study-eval-btn').addEventListener('click', async () => {
  const item     = studyState.queue[studyState.index];
  const answer   = document.querySelector('#study-answer-input').value.trim();
  const evalBtn  = document.querySelector('#study-eval-btn');

  if (!answer) return;

  evalBtn.disabled = true;
  evalBtn.textContent = 'Evaluando...';

  let prompt_text, expected_answer_text, subject;

  if (item.type === 'micro') {
    prompt_text          = item.data.question;
    expected_answer_text = item.data.expected_answer;
    subject              = item.data.parent_subject;
  } else {
    prompt_text          = item.data.prompt_text;
    expected_answer_text = item.data.expected_answer_text;
    subject              = item.data.subject;
  }

  try {
    const result = await postJson(EVALUATE_ENDPOINT, {
      prompt_text,
      user_answer_text: answer,
      expected_answer_text,
      subject: subject || ''
    });

    studyState.currentEvalResult = result;

    const gradeEl    = document.querySelector('#study-result-grade');
    const justEl     = document.querySelector('#study-result-justification');
    const missingEl  = document.querySelector('#study-result-missing');
    const grade      = normalizeSuggestedGrade(result.suggested_grade);

    gradeEl.textContent = getSuggestedGradeLabel(result.suggested_grade);
    gradeEl.className   = `study-grade-inline ${grade.toLowerCase()}`;
    justEl.textContent  = result.justification_short;

    const concepts = result.missing_concepts ?? [];
    if (concepts.length > 0) {
      missingEl.innerHTML = `<strong>Faltó:</strong> ${concepts.map((c) => `<span class="concept-tag">${c}</span>`).join(' ')}`;
      missingEl.classList.remove('hidden');
    } else {
      missingEl.textContent = '';
      missingEl.classList.add('hidden');
    }

    document.querySelector('#study-answer-block').classList.add('hidden');
    document.querySelector('#study-result-block').classList.remove('hidden');
  } catch (err) {
    evalBtn.disabled = false;
    evalBtn.textContent = 'Evaluar';
    alert(`Error al evaluar: ${err.message}`);
  }
});

document.querySelector('#study-next-btn').addEventListener('click', async () => {
  const item   = studyState.queue[studyState.index];
  const evalResult = studyState.currentEvalResult;
  if (!evalResult) { advanceStudyCard(); return; }

  const grade  = normalizeSuggestedGrade(evalResult.suggested_grade).toLowerCase();
  const gaps   = evalResult.missing_concepts ?? [];

  try {
    if (item.type === 'micro') {
      await postJson('/scheduler/review', {
        micro_card_id: item.data.id,
        grade
      });
    } else {
      const reviewResp = await postJson('/scheduler/review', {
        card_id: item.data.id,
        grade,
        concept_gaps: gaps
      });

      // Insert new micro-cards at the front of the remaining queue (study them now)
      const newMicros = (reviewResp.new_micro_cards ?? []).map((m) => ({ type: 'micro', data: m }));
      if (newMicros.length) {
        studyState.queue.splice(studyState.index + 1, 0, ...newMicros);
      }
    }
  } catch (err) {
    console.warn('Review record failed:', err.message);
  }

  studyState.results.push({
    grade,
    type: item.type,
    concept: item.type === 'micro' ? item.data.concept : null
  });

  advanceStudyCard();
});

function advanceStudyCard() {
  studyState.index++;
  if (studyState.index >= studyState.queue.length) {
    finishStudySession();
  } else {
    showStudyCard();
  }
}

function finishStudySession() {
  document.querySelector('#study-session').classList.add('hidden');
  document.querySelector('#study-overview').classList.remove('hidden');
  document.querySelector('#study-complete').classList.remove('hidden');

  const results = studyState.results;
  const passes  = results.filter((r) => r.grade === 'pass').length;
  const fails   = results.filter((r) => r.grade === 'fail').length;
  const microsPassed = results.filter((r) => r.type === 'micro' && r.grade === 'pass').length;

  document.querySelector('#study-complete-summary').innerHTML = `
    <p><strong>${passes}</strong> correctas &nbsp;·&nbsp; <strong>${fails}</strong> incorrectas</p>
    ${microsPassed > 0 ? `<p style="color:#4a7;font-size:0.9rem">${microsPassed} micro-concepto${microsPassed !== 1 ? 's' : ''} superado${microsPassed !== 1 ? 's' : ''}.</p>` : ''}
  `;

  loadStudyOverview();
}

async function getJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}
