const EVALUATE_ENDPOINT = '/evaluate';
const DECISION_ENDPOINT = '/decision';

const form = document.querySelector('#evaluation-form');
const evaluateBtn = document.querySelector('#evaluate-btn');
const resultCard = document.querySelector('#result-card');
const resultLoading = document.querySelector('#result-loading');
const resultContent = document.querySelector('#result-content');
const feedbackEl = document.querySelector('#save-feedback');

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

// --- Dictation (Web Speech API) ---

(function initDictation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const dictationBtn = document.querySelector('#dictation-btn');
  const userAnswerTextarea = document.querySelector('#user_answer_text');

  if (!SpeechRecognition) {
    return;
  }

  dictationBtn.hidden = false;

  const recognition = new SpeechRecognition();
  recognition.lang = 'es-AR';
  recognition.continuous = true;
  recognition.interimResults = true;

  let recording = false;
  let committedText = '';

  recognition.onresult = (event) => {
    let interim = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        const separator = committedText && !committedText.endsWith(' ') ? ' ' : '';
        committedText += separator + transcript.trim();
      } else {
        interim += transcript;
      }
    }

    userAnswerTextarea.value = committedText + (interim ? ' ' + interim : '');
  };

  recognition.onerror = (event) => {
    if (event.error === 'no-speech') {
      return;
    }
    stopRecording();
    setFeedback(`Error de dictado: ${event.error}`, 'error');
  };

  recognition.onend = () => {
    if (recording) {
      recognition.start();
    }
  };

  function startRecording() {
    committedText = userAnswerTextarea.value;
    recording = true;
    recognition.start();
    dictationBtn.textContent = 'Detener dictado';
    dictationBtn.classList.add('recording');
  }

  function stopRecording() {
    recording = false;
    recognition.stop();
    dictationBtn.textContent = 'Dictar respuesta';
    dictationBtn.classList.remove('recording');
  }

  dictationBtn.addEventListener('click', () => {
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
  });
})();

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
    removeManualCase(uiState.lastResult.evaluation_id);
    setFeedback('Decisión final guardada correctamente.', 'success');
  } catch (error) {
    setFeedback(`Error al guardar la decisión: ${error.message}`, 'error');
  } finally {
    uiState.savingDecision = false;
    setDecisionButtonsDisabled(false);
  }
});
