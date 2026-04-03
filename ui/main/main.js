const EVALUATE_ENDPOINT = '/evaluate';
const DECISION_ENDPOINT = '/decision';

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

  const socraticTrigger = document.querySelector('#socratic-trigger-btn');
  const socraticSection = document.querySelector('#socratic-section');
  socraticSection.classList.add('hidden');
  document.querySelector('#socratic-questions').innerHTML = '';

  if (normalizeSuggestedGrade(result.suggested_grade) === 'REVIEW') {
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

// --- Socratic questions ---

(function initSocratic() {
  const triggerBtn = document.querySelector('#socratic-trigger-btn');
  const section = document.querySelector('#socratic-section');
  const questionsContainer = document.querySelector('#socratic-questions');
  const submitBtn = document.querySelector('#socratic-submit-btn');

  triggerBtn.addEventListener('click', async () => {
    if (!uiState.lastResult || !uiState.lastRequest) return;

    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Generando preguntas...';

    try {
      const { questions } = await postJson('/socratic/questions', {
        prompt_text: uiState.lastRequest.prompt_text,
        user_answer_text: uiState.lastRequest.user_answer_text,
        expected_answer_text: uiState.lastRequest.expected_answer_text,
        subject: uiState.lastRequest.subject || '',
        dimensions: uiState.lastResult.dimensions,
        justification: uiState.lastResult.justification_short
      });

      questionsContainer.innerHTML = '';
      questions.forEach((q, i) => {
        const block = document.createElement('div');
        block.className = 'socratic-question-block';
        const label = document.createElement('label');
        label.setAttribute('for', `socratic-answer-${i}`);
        label.textContent = q;
        const textarea = document.createElement('textarea');
        textarea.id = `socratic-answer-${i}`;
        textarea.rows = 2;
        textarea.dataset.question = q;
        block.appendChild(label);
        block.appendChild(textarea);
        questionsContainer.appendChild(block);
      });

      section.classList.remove('hidden');
      triggerBtn.classList.add('hidden');
    } catch (err) {
      setFeedback(`Error al generar preguntas: ${err.message}`, 'error');
      triggerBtn.disabled = false;
      triggerBtn.textContent = 'Responder preguntas de profundización';
    }
  });

  submitBtn.addEventListener('click', async () => {
    const answerTextareas = questionsContainer.querySelectorAll('textarea');
    const socratic_qa = [];

    for (const ta of answerTextareas) {
      if (ta.value.trim().length < 3) {
        setFeedback('Respondé todas las preguntas antes de re-evaluar.', 'error');
        return;
      }
      socratic_qa.push({ question: ta.dataset.question, answer: ta.value.trim() });
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Re-evaluando...';

    try {
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
    } catch (err) {
      setFeedback(`Error en re-evaluación: ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Re-evaluar con mis respuestas';
    }
  });
})();

// --- End Socratic ---

// --- Dictation (MediaRecorder + Whisper) ---

(function initDictation() {
  if (!window.MediaRecorder || !navigator.mediaDevices) {
    return;
  }

  const dictationBtn = document.querySelector('#dictation-btn');
  const userAnswerTextarea = document.querySelector('#user_answer_text');

  dictationBtn.hidden = false;

  let mediaRecorder = null;
  let audioChunks = [];
  let stream = null;

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

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
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());

      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(audioChunks, { type: mimeType });

      dictationBtn.textContent = 'Transcribiendo...';
      dictationBtn.disabled = true;

      try {
        const base64 = await blobToBase64(blob);
        const subject = document.querySelector('#subject')?.value?.trim() || '';
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
          const current = userAnswerTextarea.value;
          const separator = current && !current.endsWith(' ') ? ' ' : '';
          userAnswerTextarea.value = current + separator + text;
        }
      } catch (err) {
        setFeedback(`Error de transcripción: ${err.message}`, 'error');
      } finally {
        dictationBtn.textContent = 'Dictar respuesta';
        dictationBtn.disabled = false;
        dictationBtn.classList.remove('recording');
      }
    };

    mediaRecorder.start();
    dictationBtn.textContent = 'Detener dictado';
    dictationBtn.classList.add('recording');
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  }

  dictationBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
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
