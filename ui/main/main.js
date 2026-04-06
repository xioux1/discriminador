const EVALUATE_ENDPOINT = '/evaluate';
const DECISION_ENDPOINT = '/decision';

// ─── Auth gate ────────────────────────────────────────────────────────────────

if (!Auth.isLoggedIn()) {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.querySelector('.app-shell')?.classList.add('hidden');
  initAuthScreen();
} else {
  document.getElementById('auth-screen').classList.add('hidden');
  const user = Auth.getUser();
  if (user) {
    const el = document.getElementById('current-username');
    if (el) el.textContent = user.username;
  }
}

function initAuthScreen() {
  let mode = 'login';
  const tabs = document.querySelectorAll('.auth-tab');
  tabs.forEach(t => t.addEventListener('click', () => {
    mode = t.dataset.tab;
    tabs.forEach(x => x.classList.toggle('active', x.dataset.tab === mode));
    document.getElementById('auth-error').classList.add('hidden');
  }));

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const errEl = document.getElementById('auth-error');
    const submitBtn = document.querySelector('.auth-submit');
    submitBtn.disabled = true;
    errEl.classList.add('hidden');
    try {
      if (mode === 'login') await Auth.login(username, password);
      else await Auth.register(username, password);
      location.reload();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      submitBtn.disabled = false;
    }
  });
}

document.getElementById('logout-btn')?.addEventListener('click', () => Auth.logout());

// If not logged in, stop here — don't run any initialization that makes API calls
if (!Auth.isLoggedIn()) {
  // Auth screen is already shown above; nothing else to do
  throw new Error('__auth_gate__'); // halts script execution cleanly
}

// --- Tab navigation ---

(function initTabs() {
  const tabs          = document.querySelectorAll('.tab-btn');
  const tabSections   = {
    dashboard: document.querySelector('#tab-dashboard'),
    study:     document.querySelector('#tab-study'),
    evaluate:  document.querySelector('#tab-evaluate'),
    explore:   document.querySelector('#tab-explore'),
    progress:  document.querySelector('#tab-progress'),
  };
  let loaded = { dashboard: false, study: false, explore: false, progress: false };

  function showTab(tab) {
    Object.values(tabSections).forEach((s) => s.classList.add('hidden'));
    if (tabSections[tab]) tabSections[tab].classList.remove('hidden');
  }

  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      showTab(tab);

      if (tab === 'explore' && !loaded.explore) {
        loaded.explore = true; loadHistoryOverview();
      } else if (tab === 'study' && !loaded.study) {
        loaded.study = true; initStudyTab();
      } else if (tab === 'dashboard' && !loaded.dashboard) {
        loaded.dashboard = true; loadDashboard();
      } else if (tab === 'progress' && !loaded.progress) {
        loaded.progress = true; loadProgress();
      }
    });
  });

  // Show dashboard on load
  showTab('dashboard');
  loaded.dashboard = true;
  loadDashboard();
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
    const res = await fetch('/stats/overview', {
      headers: Auth.getToken() ? { 'Authorization': 'Bearer ' + Auth.getToken() } : {}
    });
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
              const r = await fetch(`/stats/question?prompt=${encodeURIComponent(q.prompt_text)}`, {
                headers: Auth.getToken() ? { 'Authorization': 'Bearer ' + Auth.getToken() } : {}
              });
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

// --- Dashboard ---

async function loadDashboard() {
  const loading = document.querySelector('#dashboard-loading');
  const content = document.querySelector('#dashboard-content');
  loading.classList.remove('hidden');
  content.innerHTML = '';

  try {
    const [overview, session] = await Promise.all([
      getJson('/stats/overview').catch(() => ({ subjects: [] })),
      getJson('/scheduler/session').catch(() => ({ cards: [], micro_cards: [] }))
    ]);

    loading.classList.add('hidden');

    const normalizeSubject = (subject) => {
      const normalized = typeof subject === 'string' ? subject.trim() : '';
      return normalized || '(sin materia)';
    };

    const subjects = (overview.subjects || []).map((subj) => ({
      ...subj,
      subject: normalizeSubject(subj.subject)
    }));
    if (!subjects.length) {
      content.innerHTML = '<p style="color:var(--text-muted);padding:16px">Aún no hay evaluaciones registradas. Empezá evaluando en la pestaña Evaluar.</p>';
      return;
    }

    // Build pending cards and active micro-consignas per subject from session
    const pendingCardsBySubject = {};
    const activeMicrosBySubject = {};
    for (const card of session.cards ?? []) {
      const s = normalizeSubject(card.subject);
      pendingCardsBySubject[s] = (pendingCardsBySubject[s] || 0) + 1;
    }
    for (const mc of session.micro_cards ?? []) {
      const s = normalizeSubject(mc.parent_subject);
      activeMicrosBySubject[s] = (activeMicrosBySubject[s] || 0) + 1;
    }
    const totalPendingCards = Object.values(pendingCardsBySubject).reduce((a, b) => a + b, 0);
    const totalActiveMicros = Object.values(activeMicrosBySubject).reduce((a, b) => a + b, 0);
    const totalDue = totalPendingCards + totalActiveMicros;

    if (totalDue > 0) {
      const banner = document.createElement('div');
      banner.className = 'card';
      banner.style.cssText = 'background:var(--primary-light,#e8f0fe);margin-bottom:12px';
      banner.innerHTML = `<strong>${totalDue}</strong> pendiente${totalDue !== 1 ? 's' : ''} hoy (<strong>${totalPendingCards}</strong> tarjeta${totalPendingCards !== 1 ? 's' : ''} principal${totalPendingCards !== 1 ? 'es' : ''} + <strong>${totalActiveMicros}</strong> microconsigna${totalActiveMicros !== 1 ? 's' : ''}).`;
      content.appendChild(banner);
    }

    const panel = document.createElement('div');
    panel.className = 'subjects-panel card';
    panel.innerHTML = '<h3 class="subjects-panel-title">Materias</h3>';

    const list = document.createElement('ul');
    list.className = 'subjects-list';

    const subjectNames = [...new Set([
      ...subjects.map((subj) => subj.subject),
      ...Object.keys(pendingCardsBySubject),
      ...Object.keys(activeMicrosBySubject)
    ])].sort((a, b) => a.localeCompare(b, 'es'));

    for (const subjectName of subjectNames) {
      const pendingMainCards = pendingCardsBySubject[subjectName] || 0;
      const activeMicros = activeMicrosBySubject[subjectName] || 0;

      const row = document.createElement('li');
      row.className = 'subjects-list-item';
      row.innerHTML = `
        <div class="subjects-list-main">
          <div class="subjects-list-name">${subjectName}</div>
          <div class="subjects-list-meta">Tarjetas principales pendientes: ${pendingMainCards} · Microconsignas activas: ${activeMicros}</div>
        </div>
        <div class="subjects-list-actions">
          <button type="button" class="btn-primary deck-study-btn" data-subject="${subjectName}">Estudiar</button>
          <button type="button" class="btn-secondary deck-config-btn" data-subject="${subjectName}">Configurar</button>
        </div>
      `;
      list.appendChild(row);
    }

    panel.appendChild(list);
    content.appendChild(panel);

    list.addEventListener('click', (e) => {
      if (e.target.classList.contains('deck-study-btn')) {
        document.querySelector('[data-tab="study"]').click();
      }
      if (e.target.classList.contains('deck-config-btn')) {
        openCurriculumModal(e.target.dataset.subject);
      }
    });
  } catch (err) {
    loading.classList.add('hidden');
    content.innerHTML = `<p style="color:var(--fail-fg);padding:16px">Error al cargar: ${err.message}</p>`;
  }
}

// --- Progress tab ---

async function loadProgress() {
  const loading = document.querySelector('#progress-loading');
  const content = document.querySelector('#progress-content');
  loading.classList.remove('hidden');
  content.classList.add('hidden');

  try {
    const [actData, overview] = await Promise.all([
      getJson('/stats/activity?days=3650'),
      getJson('/stats/overview').catch(() => ({ subjects: [] }))
    ]);

    loading.classList.add('hidden');
    content.classList.remove('hidden');

    // Streak pills
    const pills = document.querySelector('#progress-pills');
    pills.innerHTML = '';
    [
      { label: `Racha: ${actData.streak_current} día${actData.streak_current !== 1 ? 's' : ''}`, cls: actData.streak_current > 0 ? 'pass' : '' },
      { label: `Mejor racha: ${actData.streak_best} días`, cls: '' },
      { label: `Total revisiones: ${actData.total_reviews}`, cls: '' }
    ].forEach(({ label, cls }) => {
      const span = document.createElement('span');
      span.className = `progress-pill${cls ? ' ' + cls : ''}`;
      span.textContent = label;
      pills.appendChild(span);
    });

    // Heatmap — año calendario completo, navegable por año
    const grid = document.querySelector('#heatmap-grid');
    const monthLabels = document.querySelector('#heatmap-month-labels');
    const yearLabels = document.querySelector('#heatmap-year-labels');
    const heatmapContainer = document.querySelector('#heatmap-container');
    const heatmapTitle = document.querySelector('#heatmap-title');
    const prevYearBtn = document.querySelector('#heatmap-prev-year');
    const nextYearBtn = document.querySelector('#heatmap-next-year');
    grid.innerHTML = '';
    monthLabels.innerHTML = '';
    yearLabels.innerHTML = '';

    const dayMap = {};
    let maxCount = 0;
    for (const d of actData.days || []) {
      const key = typeof d.date === 'string' ? d.date.slice(0, 10) : new Date(d.date).toISOString().slice(0, 10);
      dayMap[key] = d.count;
      if (d.count > maxCount) maxCount = d.count;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayYear = today.getFullYear();
    const availableYears = (actData.days || [])
      .map((d) => Number(String(typeof d.date === 'string' ? d.date : new Date(d.date).toISOString()).slice(0, 4)))
      .filter((y) => Number.isFinite(y));
    const minYearFromData = availableYears.length ? Math.min(...availableYears) : todayYear;
    const minYear = Math.min(minYearFromData, todayYear);
    let selectedYear = Math.max(minYear, todayYear);

    const monthFmt = new Intl.DateTimeFormat('es-AR', { month: 'short' });

    const renderYearHeatmap = (year) => {
      selectedYear = year;
      grid.innerHTML = '';
      monthLabels.innerHTML = '';
      yearLabels.innerHTML = '';
      heatmapTitle.textContent = `Actividad (año ${year})`;

      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31);

      const alignedStart = new Date(startDate);
      alignedStart.setDate(alignedStart.getDate() - alignedStart.getDay());
      const alignedEnd = new Date(endDate);
      alignedEnd.setDate(alignedEnd.getDate() + (6 - alignedEnd.getDay()));

      const MS_PER_DAY = 24 * 60 * 60 * 1000;
      const totalDays = Math.floor((alignedEnd - alignedStart) / MS_PER_DAY) + 1;
      const weekCount = Math.ceil(totalDays / 7);

      const containerWidth = heatmapContainer.clientWidth || 800;
      const paddingForScroll = 8;
      const gap = 3;
      const computedCell = Math.floor((containerWidth - paddingForScroll - ((weekCount - 1) * gap)) / weekCount);
      const cellSize = Math.max(8, Math.min(13, computedCell));
      heatmapContainer.style.setProperty('--heatmap-cell', `${cellSize}px`);
      heatmapContainer.style.setProperty('--heatmap-gap', `${gap}px`);

      grid.style.gridTemplateColumns = `repeat(${weekCount}, ${cellSize}px)`;
      monthLabels.style.gridTemplateColumns = `repeat(${weekCount}, ${cellSize}px)`;
      yearLabels.style.gridTemplateColumns = `repeat(${weekCount}, ${cellSize}px)`;

      for (let i = 0; i < totalDays; i++) {
        const date = new Date(alignedStart);
        date.setDate(alignedStart.getDate() + i);
        const dateStr = date.toISOString().slice(0, 10);
        const inSelectedYear = date >= startDate && date <= endDate;
        const count = inSelectedYear ? (dayMap[dateStr] || 0) : 0;
        const lvl = count === 0 ? 0 : Math.min(4, Math.ceil((count / Math.max(maxCount, 1)) * 4));
        const weekIndex = Math.floor(i / 7);

        if (date.getDay() === 0 && date.getDate() <= 7 && inSelectedYear) {
          const monthEl = document.createElement('span');
          monthEl.className = 'heatmap-label';
          monthEl.style.gridColumn = `${weekIndex + 1} / span 4`;
          monthEl.textContent = monthFmt.format(date);
          monthLabels.appendChild(monthEl);
        }

        const cell = document.createElement('div');
        cell.className = `heatmap-cell${inSelectedYear ? '' : ' is-padding'}`;
        cell.setAttribute('data-lvl', lvl);
        cell.title = inSelectedYear ? `${dateStr}: ${count} revisiones` : `${dateStr}: fuera del año`;
        grid.appendChild(cell);
      }

      const yearEl = document.createElement('span');
      yearEl.className = 'heatmap-label';
      yearEl.style.gridColumn = '1 / span 8';
      yearEl.textContent = String(year);
      yearLabels.appendChild(yearEl);

      prevYearBtn.disabled = selectedYear <= minYear;
      nextYearBtn.disabled = selectedYear >= todayYear;
    };

    prevYearBtn.onclick = () => renderYearHeatmap(Math.max(minYear, selectedYear - 1));
    nextYearBtn.onclick = () => renderYearHeatmap(Math.min(todayYear, selectedYear + 1));
    if (window.__heatmapResizeHandler) window.removeEventListener('resize', window.__heatmapResizeHandler);
    window.__heatmapResizeHandler = () => renderYearHeatmap(selectedYear);
    window.addEventListener('resize', window.__heatmapResizeHandler);
    renderYearHeatmap(selectedYear);

    // Per-subject stats
    const subjEl = document.querySelector('#progress-subjects');
    subjEl.innerHTML = '';
    const subjects = (overview.subjects || []).filter((s) => s.total_questions > 0);
    if (subjects.length > 0) {
      for (const s of subjects) {
        const pct = Math.round(s.pass_rate * 100);
        const row = document.createElement('div');
        row.className = 'progress-subject-row';
        row.innerHTML = `
          <span class="progress-subject-name">${s.subject}</span>
          <div class="progress-subject-bar-track">
            <div class="dimension-bar-fill${pct < 40 ? ' weak' : pct < 70 ? ' mid' : ''}" style="width:${pct}%"></div>
          </div>
          <span class="progress-subject-pct" style="color:${pct >= 60 ? 'var(--pass-fg)' : 'var(--fail-fg)'}">${pct}%</span>
          <span class="progress-subject-count">${s.total_questions}q</span>
        `;
        subjEl.appendChild(row);
      }
    } else {
      subjEl.innerHTML = '<p style="color:var(--text-muted)">Aún no hay datos por materia.</p>';
    }
    // Populate advisor subject select
    const advisorPanel = document.querySelector('#progress-advisor');
    const advisorSelect = document.querySelector('#advisor-subject-select');
    advisorSelect.innerHTML = '<option value="">Seleccioná una materia</option>';
    (overview.subjects || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.subject;
      opt.textContent = s.subject;
      advisorSelect.appendChild(opt);
    });
    advisorPanel.classList.remove('hidden');

    advisorSelect.addEventListener('change', () => {
      if (advisorSelect.value) loadAdvisorAnalysis(advisorSelect.value);
      else document.querySelector('#advisor-content').innerHTML = '';
    });
  } catch (err) {
    loading.classList.add('hidden');
    document.querySelector('#progress-content').innerHTML =
      `<p style="color:var(--fail-fg);padding:16px">Error al cargar progreso: ${err.message}</p>`;
    document.querySelector('#progress-content').classList.remove('hidden');
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
    const res = await fetch('/subjects', {
      headers: Auth.getToken() ? { 'Authorization': 'Bearer ' + Auth.getToken() } : {}
    });
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
let _expectedAnswerCache = null; // { expected_answer_text, subject }
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
    const res = await fetch(`/expected-answer?prompt=${encodeURIComponent(promptText.trim())}`, {
      headers: Auth.getToken() ? { 'Authorization': 'Bearer ' + Auth.getToken() } : {}
    });
    if (!res.ok) { clearExpectedHint(); return; }
    const data = await res.json();
    if (data.found && data.expected_answer_text) {
      _expectedAnswerCache = { expected_answer_text: data.expected_answer_text, subject: data.subject };
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
    document.querySelector('#expected_answer_text').value = _expectedAnswerCache.expected_answer_text;
    // Auto-fill subject only if the field is currently empty
    const subjectInput = document.querySelector('#subject');
    if (_expectedAnswerCache.subject && !subjectInput.value.trim()) {
      subjectInput.value = _expectedAnswerCache.subject;
    }
    fillExpectedBtn.classList.add('hidden');
  }
});

// --- Math Palette + SQL Editor (Evaluate tab) ---

MathPalette.init();

const _evalAnswerTextarea = document.querySelector('#user_answer_text');
const _editorModeSelect   = document.querySelector('#editor-mode-select');

_evalAnswerTextarea.addEventListener('focus', function () {
  MathPalette.setActiveTextarea(_evalAnswerTextarea);
});

function attachMathTabInsertion(textarea, isMathModeFn) {
  if (!textarea) return;
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!isMathModeFn()) return;
    event.preventDefault();
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.setRangeText('  ', start, end, 'end');
  });
}

attachMathTabInsertion(_evalAnswerTextarea, () => (_editorModeSelect?.value || '') === 'math');

function _subjectModeKey(subject) {
  return 'editor-mode:' + (subject || '').trim().toLowerCase();
}
function getSubjectMode(subject) {
  return localStorage.getItem(_subjectModeKey(subject)) || '';
}
function saveSubjectMode(subject, mode) {
  if (!subject || !subject.trim()) return;
  if (mode) {
    localStorage.setItem(_subjectModeKey(subject), mode);
  } else {
    localStorage.removeItem(_subjectModeKey(subject));
  }
}

function setEvalSqlCompilerVisible(visible) {
  const panel = document.querySelector('#eval-sql-compiler');
  if (!panel) return;
  if (visible) {
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
    // Hide output and re-enable submit button
    const out = document.querySelector('#eval-compiler-output');
    if (out) { out.classList.add('hidden'); out.className = 'sql-compiler-output hidden'; out.textContent = ''; }
  }
}

function applyEditorMode(mode, subject) {
  if (mode === 'math') {
    MathPalette.show();
    SqlEditor.deactivate();
    setEvalSqlCompilerVisible(false);
  } else if (mode === 'sql') {
    MathPalette.hide();
    SqlEditor.activate(_evalAnswerTextarea);
    setEvalSqlCompilerVisible(true);
  } else {
    // No auto-detection — plain text unless explicitly set
    MathPalette.updateSubject(subject || '');
    SqlEditor.deactivate();
    setEvalSqlCompilerVisible(false);
  }
}

// When subject changes: load saved mode for that subject
document.querySelector('#subject').addEventListener('input', function (e) {
  const subjectVal = e.target.value;
  const savedMode  = getSubjectMode(subjectVal);
  if (_editorModeSelect) _editorModeSelect.value = savedMode;
  applyEditorMode(savedMode, subjectVal);
});

// When mode selector changes: save and apply
if (_editorModeSelect) {
  _editorModeSelect.addEventListener('change', function () {
    const subject = document.querySelector('#subject').value;
    const mode    = _editorModeSelect.value;
    saveSubjectMode(subject, mode);
    applyEditorMode(mode, subject);
  });
}

// Evaluar-tab SQL verify button
const _evalVerifyBtn = document.querySelector('#eval-verify-btn');
if (_evalVerifyBtn) {
  _evalVerifyBtn.addEventListener('click', async function () {
    const sql = (_evalAnswerTextarea && _evalAnswerTextarea.value.trim()) || '';
    if (!sql) return;
    const out = document.querySelector('#eval-compiler-output');
    _evalVerifyBtn.disabled = true;
    await verifySql(sql, out);
    _evalVerifyBtn.disabled = false;
  });
}

// --- SQL compiler shared helper ---

/**
 * Client-side static checks for unambiguous syntax errors.
 * These are deterministic — no LLM variability.
 */
function sqlClientSideErrors(sql) {
  const errors = [];
  const lines = sql.split('\n');
  const MAJOR_CLAUSE = /^(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|UNION|INTERSECT|MINUS|EXCEPT|JOIN|INNER\s+JOIN|LEFT|RIGHT|FULL|CROSS)\b/i;

  // 1. Trailing comma before a major SQL clause
  for (let i = 0; i < lines.length; i++) {
    if (/,\s*$/.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) continue;
        const m = next.match(MAJOR_CLAUSE);
        if (m) {
          errors.push({
            line: i + 1,
            message: `ORA-00936: expresión faltante — coma extra antes de ${m[0].toUpperCase().trim()}`,
            hint: `Eliminá la coma al final de la línea ${i + 1}`,
          });
        }
        break;
      }
    }
  }

  // 2. Stray END / END; in plain SQL context (no PL/SQL block)
  const hasPLSQL = /\bBEGIN\b|\bDECLARE\b|\bCREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|TRIGGER|PACKAGE)\b/i.test(sql);
  if (!hasPLSQL) {
    lines.forEach((line, i) => {
      if (/^\s*END\s*;?\s*$/.test(line.trim())) {
        errors.push({
          line: i + 1,
          message: `ORA-00900: instrucción SQL no válida — END sin bloque BEGIN/PL/SQL`,
          hint: `Eliminá el END; — no corresponde a una consulta SQL estándar`,
        });
      }
    });
  }

  // 3. Unbalanced parentheses
  let depth = 0;
  let lastOpen = -1;
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '(') { depth++; lastOpen = i + 1; }
      else if (ch === ')') { depth--; }
    }
  }
  if (depth > 0) {
    errors.push({ line: lastOpen, message: `ORA-00907: falta el paréntesis derecho`, hint: `Revisá que cada ( tenga su ) correspondiente` });
  } else if (depth < 0) {
    errors.push({ line: lines.length, message: `ORA-00907: paréntesis de cierre sin apertura`, hint: `Hay un ) de más` });
  }

  return errors;
}

function _renderErrors(errors, outputEl) {
  outputEl.className = 'sql-compiler-output invalid';
  outputEl.textContent = errors.map((e) => {
    let msg = e.line ? `LÍNEA ${e.line}: ` : '';
    msg += e.message;
    if (e.hint) msg += `\n  > ${e.hint}`;
    return msg;
  }).join('\n\n');
}

async function verifySql(sqlText, outputEl) {
  outputEl.classList.remove('hidden');
  outputEl.className = 'sql-compiler-output';
  outputEl.textContent = 'Verificando…';

  // Phase 1: deterministic client-side checks (no LLM variability)
  const staticErrors = sqlClientSideErrors(sqlText);
  if (staticErrors.length > 0) {
    _renderErrors(staticErrors, outputEl);
    return false;
  }

  // Phase 2: LLM deep analysis
  try {
    const sqlHeaders = { 'Content-Type': 'application/json' };
    if (Auth.getToken()) sqlHeaders['Authorization'] = 'Bearer ' + Auth.getToken();
    const resp = await fetch('/api/sql/validate', {
      method: 'POST',
      headers: sqlHeaders,
      body: JSON.stringify({ sql: sqlText }),
    });
    const data = await resp.json();
    const llmErrors = (data.errors || []).filter((e) => e && e.message);

    if (data.valid || llmErrors.length === 0) {
      outputEl.className = 'sql-compiler-output valid';
      outputEl.textContent = 'Compilación exitosa - sin errores de sintaxis';
      return true;
    } else {
      _renderErrors(llmErrors, outputEl);
      return false;
    }
  } catch (_err) {
    outputEl.className = 'sql-compiler-output valid';
    outputEl.textContent = 'Verificación no disponible - podés continuar';
    return true;
  }
}

// --- Reset form after decision ---
function resetForm() {
  const subject = form.subject.value;
  form.reset();
  form.subject.value = subject;
  SqlEditor.refresh(); // clear ghost text from highlight layer
  clearExpectedHint();
  resultCard.classList.add('hidden');
  resultContent.classList.add('hidden');
  resultLoading.classList.add('hidden');
  uiState.lastRequest = null;
  uiState.lastResult = null;
  // Reset compiler output (but keep panel visible if SQL mode)
  const evalOut = document.querySelector('#eval-compiler-output');
  if (evalOut) { evalOut.className = 'sql-compiler-output hidden'; evalOut.textContent = ''; }
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

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escapePreserve(text) {
  return escHtml(text).replace(/\n/g, '<br>');
}

function looksLikeCodeBlock(text = '') {
  if (!text) return false;
  return /(^|\n)\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|DECLARE)\b/i.test(text)
    || /[{};]/.test(text)
    || /(^|\n)\s{2,}\S/.test(text);
}

function formatAnswerBlock(label, text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (looksLikeCodeBlock(raw)) {
    return `<div class="study-answer-compare-block"><strong>${label}:</strong><pre><code>${escHtml(raw)}</code></pre></div>`;
  }
  return `<div class="study-answer-compare-block"><strong>${label}:</strong><div class="study-answer-compare-text">${escapePreserve(raw)}</div></div>`;
}

async function deleteJson(url) {
  const headers = {};
  if (Auth.getToken()) headers['Authorization'] = 'Bearer ' + Auth.getToken();
  const response = await fetch(url, { method: 'DELETE', headers });
  Auth.handleRefreshToken(response);
  if (response.status === 401) { if (Auth.isLoggedIn()) Auth.logout(); return {}; }
  try { return await response.json(); } catch (_e) { return {}; }
}

async function postJson(url, body, method = 'POST') {
  const headers = { 'Content-Type': 'application/json' };
  if (Auth.getToken()) headers['Authorization'] = 'Bearer ' + Auth.getToken();
  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });

  Auth.handleRefreshToken(response);
  if (response.status === 401) { if (Auth.isLoggedIn()) Auth.logout(); return; }

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

// --- SQL clause checklist renderer (shared by Evaluate + Study tabs) ---
function renderClauseChecklist(clauses) {
  const statusIcon = { present: 'ok', missing: 'x', extra: '~' };
  const items = clauses.map((c) =>
    `<span class="sql-clause-item ${c.status}"><span class="sql-clause-label">${statusIcon[c.status]}</span>${c.name}</span>`
  ).join('');
  return `<div class="sql-clause-checklist">${items}</div>`;
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

    // SQL clause checklist — insert between dimensions list and action buttons
    let sqlChecklistEl = document.querySelector('#sql-clause-checklist');
    if (sqlChecklistEl) sqlChecklistEl.remove();
    if (SqlEditor.isActive() && payload.expected_answer_text) {
      const clauses = SqlEditor.checkClauses(payload.user_answer_text, payload.expected_answer_text);
      if (clauses.length > 0) {
        sqlChecklistEl = document.createElement('div');
        sqlChecklistEl.id = 'sql-clause-checklist';
        sqlChecklistEl.innerHTML = renderClauseChecklist(clauses);
        const actionsEl = resultContent.querySelector('.actions');
        if (actionsEl) {
          actionsEl.parentNode.insertBefore(sqlChecklistEl, actionsEl);
        } else {
          resultContent.appendChild(sqlChecklistEl);
        }
      }
    }

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
    const res = await fetch(`/stats/question?prompt=${encodeURIComponent(promptText.trim())}`, {
      headers: Auth.getToken() ? { 'Authorization': 'Bearer ' + Auth.getToken() } : {}
    });
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
        <span class="dimension-bar-label">${DIM_LABELS[dimension] || dimension}${fail_count > 0 ? ` <small>(${fail_count}x)</small>` : ''}</span>
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
        const subject = typeof subjectOverride === 'function'
        ? subjectOverride()
        : (subjectOverride ?? document.querySelector('#subject')?.value?.trim() ?? '');
        const transcribeHeaders = { 'Content-Type': 'application/json' };
        if (Auth.getToken()) transcribeHeaders['Authorization'] = 'Bearer ' + Auth.getToken();
        const response = await fetch('/transcribe', {
          method: 'POST',
          headers: transcribeHeaders,
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

// Briefing state
const briefingState = {
  selectedTime:     null,   // number of minutes
  selectedEnergy:   null,   // 'tired'|'normal'|'focused'
  plan:             null,   // response from server
  fullCards:        [],     // full cards from server
  fullMicroCards:   []      // full micro_cards from server
};

function initStudyTab() {
  // Show briefing first, hide overview
  document.querySelector('#study-briefing').classList.remove('hidden');
  document.querySelector('#study-overview').classList.add('hidden');

  document.querySelector('#study-add-card-btn').addEventListener('click', () => {
    document.querySelector('#study-add-form').classList.remove('hidden');
    document.querySelector('#study-agenda').classList.add('hidden');
  });
  document.querySelector('#study-agenda-btn').addEventListener('click', loadAgenda);
  document.querySelector('#agenda-close-btn').addEventListener('click', () => {
    document.querySelector('#study-agenda').classList.add('hidden');
  });
  document.querySelector('#card-cancel-btn').addEventListener('click', () => {
    document.querySelector('#study-add-form').classList.add('hidden');
  });
  document.querySelector('#card-save-btn').addEventListener('click', saveNewCard);
  document.querySelector('#study-start-btn').addEventListener('click', startStudySession);
  document.querySelector('#study-exit-btn').addEventListener('click', exitStudySession);
  document.querySelector('#study-edit-prompt-btn').addEventListener('click', toggleStudyPromptEdit);
  document.querySelector('#study-clarify-prompt-btn').addEventListener('click', clarifyStudyPrompt);

  // Link to show overview/add-card from briefing
  document.querySelector('#briefing-overview-link').addEventListener('click', () => {
    document.querySelector('#study-briefing').classList.add('hidden');
    document.querySelector('#study-overview').classList.remove('hidden');
    loadStudyOverview();
  });

  // Attach dictation once — subject is read dynamically from data-subject on the button
  const studyDictBtn = document.querySelector('#study-dictation-btn');
  attachDictation(
    studyDictBtn,
    document.querySelector('#study-answer-input'),
    'Dictar',
    () => studyDictBtn.dataset.subject || ''
  );
  attachMathTabInsertion(
    document.querySelector('#study-answer-input'),
    () => studyState.currentInputMode === 'math'
  );

  document.querySelector('#study-again-btn').addEventListener('click', () => {
    document.querySelector('#study-complete').classList.add('hidden');
    document.querySelector('#study-overview').classList.add('hidden');
    // Reset briefing state
    briefingState.selectedTime   = null;
    briefingState.selectedEnergy = null;
    briefingState.plan           = null;
    briefingState.fullCards      = [];
    briefingState.fullMicroCards = [];
    document.querySelectorAll('.briefing-opt').forEach((b) => b.classList.remove('selected'));
    document.querySelector('#briefing-plan-area').classList.add('hidden');
    document.querySelector('#briefing-start-btn').classList.add('hidden');
    document.querySelector('#briefing-plan-btn').disabled = true;
    document.querySelector('#study-briefing').classList.remove('hidden');
  });

  initBriefing();
}

(function initBriefing() {
  // Time options
  document.querySelectorAll('#briefing-time-options .briefing-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#briefing-time-options .briefing-opt').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      briefingState.selectedTime = parseInt(btn.dataset.value);
      checkBriefingReady();
    });
  });

  // Energy options
  document.querySelectorAll('#briefing-energy-options .briefing-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#briefing-energy-options .briefing-opt').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      briefingState.selectedEnergy = btn.dataset.value;
      checkBriefingReady();
    });
  });

  document.querySelector('#briefing-plan-btn').addEventListener('click', fetchSessionPlan);
  document.querySelector('#briefing-start-btn').addEventListener('click', startPlannedSession);
})();

function checkBriefingReady() {
  const btn = document.querySelector('#briefing-plan-btn');
  btn.disabled = !(briefingState.selectedTime && briefingState.selectedEnergy);
}

async function fetchSessionPlan() {
  const loadingEl = document.querySelector('#briefing-loading');
  const planBtn   = document.querySelector('#briefing-plan-btn');
  const startBtn  = document.querySelector('#briefing-start-btn');
  const planArea  = document.querySelector('#briefing-plan-area');

  loadingEl.classList.remove('hidden');
  planBtn.disabled = true;
  startBtn.classList.add('hidden');

  try {
    const data = await postJson('/session/plan', {
      available_minutes: briefingState.selectedTime,
      energy_level:      briefingState.selectedEnergy
    });

    briefingState.plan           = data.plan;
    briefingState.fullCards      = data.cards;
    briefingState.fullMicroCards = data.micro_cards;

    // Render tip
    document.querySelector('#briefing-tip').textContent = data.plan.session_tip || '';

    // Render warnings
    const warnEl = document.querySelector('#briefing-warnings');
    warnEl.innerHTML = (data.plan.warnings || []).map((w) =>
      `<div style="color:var(--fail-fg);font-size:0.85rem;margin-bottom:6px">Advertencia: ${w}</div>`
    ).join('');

    // Render plan summary
    const planned  = data.plan.planned  || [];
    const deferred = data.plan.deferred || [];
    const summaryEl = document.querySelector('#briefing-plan-summary');

    if (planned.length === 0) {
      summaryEl.innerHTML = '<p style="color:var(--text-muted)">No hay tarjetas pendientes para hoy. ¡Al día!</p>';
      startBtn.classList.add('hidden');
    } else {
      summaryEl.innerHTML = `
        <div style="font-weight:600;margin-bottom:8px">${planned.length} tarjeta${planned.length !== 1 ? 's' : ''} · ~${data.plan.total_estimated_minutes} min</div>
        ${planned.map((p) => `
          <div class="briefing-plan-row">
            <span>${p.subject}</span>
            <span style="color:var(--text-muted);font-size:0.8rem">~${Math.round(p.estimated_ms / 1000)}s</span>
          </div>`).join('')}
        ${deferred.length > 0 ? `<div class="briefing-deferred">+ ${deferred.length} tarjeta${deferred.length !== 1 ? 's' : ''} postergada${deferred.length !== 1 ? 's' : ''} para otra sesión</div>` : ''}
      `;
      startBtn.classList.remove('hidden');
    }

    planArea.classList.remove('hidden');
  } catch (err) {
    document.querySelector('#briefing-tip').textContent = `Error: ${err.message}`;
    document.querySelector('#briefing-warnings').innerHTML = '';
    document.querySelector('#briefing-plan-summary').innerHTML = '';
    planArea.classList.remove('hidden');
  } finally {
    loadingEl.classList.add('hidden');
    planBtn.disabled = false;
  }
}

function startPlannedSession() {
  const plan = briefingState.plan;
  if (!plan || !plan.planned?.length) return;

  // Build lookup maps
  const microById = {};
  briefingState.fullMicroCards.forEach((m) => { microById[m.id] = m; });
  const cardById = {};
  briefingState.fullCards.forEach((c) => { cardById[c.id] = c; });

  const queue = [];
  for (const item of plan.planned) {
    if (item.type === 'micro' && microById[item.id]) {
      queue.push({ type: 'micro', data: microById[item.id] });
    } else if (item.type === 'card' && cardById[item.id]) {
      queue.push({ type: 'card', data: cardById[item.id] });
    }
  }

  if (queue.length === 0) return;

  studyState.queue                 = queue;
  studyState.index                 = 0;
  studyState.results               = [];
  studyState.sessionStartTime      = Date.now();
  studyState.sessionLimitMs        = briefingState.selectedTime * 60 * 1000;
  studyState.sessionEnergyLevel    = briefingState.selectedEnergy;

  document.querySelector('#study-briefing').classList.add('hidden');
  document.querySelector('#study-overview').classList.add('hidden');
  document.querySelector('#study-complete').classList.add('hidden');
  document.querySelector('#study-session').classList.remove('hidden');

  showStudyCard();
}

function exitStudySession() {
  if (studyState.timerInterval) {
    clearInterval(studyState.timerInterval);
    studyState.timerInterval = null;
  }
  document.querySelector('#study-session').classList.add('hidden');
  document.querySelector('#study-overview').classList.remove('hidden');
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
  queue: [],            // [{type:'card'|'micro', data:{...}}]
  index: 0,
  results: [],          // {grade, type, concept?}
  currentEvalResult: null,
  currentEvalContext: null,
  currentDecision: null,
  currentInputMode: '',
  cardStartTime: 0,
  responseTimeMs: 0,
  timerInterval: null
};

function getStudyPromptText(item) {
  if (!item) return '';
  if (item.type === 'micro') {
    return item.data.session_question || item.data.question;
  }
  return item.data.session_prompt_text || item.data.prompt_text;
}

function setStudyPromptFeedback(message, type = 'info') {
  const feedbackEl = document.querySelector('#study-prompt-feedback');
  if (!feedbackEl) return;
  feedbackEl.textContent = message || '';
  feedbackEl.classList.toggle('hidden', !message);
  feedbackEl.style.color = type === 'error' ? '#c00' : type === 'success' ? '#2f7d32' : '';
}

async function startStudySession() {
  const data = await getJson('/scheduler/session');
  const micros = (data.micro_cards ?? []).map((m) => ({ type: 'micro', data: m }));
  const cards  = (data.cards ?? []).map((c) => ({ type: 'card', data: c }));

  studyState.queue   = [...micros, ...cards];
  studyState.index   = 0;
  studyState.results = [];
  studyState.currentEvalResult = null;
  studyState.currentEvalContext = null;
  studyState.currentDecision = null;

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
  const pct = Math.round(((current - 1) / total) * 100);
  document.querySelector('#study-progress-fill').style.width = `${pct}%`;

  const badge = document.querySelector('#study-card-badge');
  const promptEl = document.querySelector('#study-card-prompt');
  const parentContextEl = document.querySelector('#study-card-parent-context');
  const parentPromptEl  = document.querySelector('#study-card-parent-prompt');

  if (item.type === 'micro') {
    badge.textContent = `Micro-concepto: ${item.data.concept}`;
    badge.classList.remove('hidden');
    promptEl.textContent = getStudyPromptText(item);
    // Show parent card as context so student knows what topic this stems from
    if (item.data.parent_prompt) {
      parentPromptEl.textContent = item.data.parent_prompt;
      parentContextEl.classList.remove('hidden');
    } else {
      parentContextEl.classList.add('hidden');
    }
  } else {
    badge.classList.add('hidden');
    parentContextEl.classList.add('hidden');
    const hasMicros = parseInt(item.data.active_micro_count) > 0;
    badge.textContent = hasMicros ? `Advertencia: Conceptos pendientes (${item.data.active_micro_count})` : '';
    if (hasMicros) badge.classList.remove('hidden');
    promptEl.textContent = getStudyPromptText(item);
  }
  setStudyPromptFeedback('');

  const editPromptBtn = document.querySelector('#study-edit-prompt-btn');
  const clarifyPromptBtn = document.querySelector('#study-clarify-prompt-btn');
  if (editPromptBtn) editPromptBtn.textContent = 'Editar';
  if (clarifyPromptBtn) clarifyPromptBtn.disabled = false;

  // Reset answer + result blocks (refresh SQL layer to clear ghost text)
  const _studyInput = document.querySelector('#study-answer-input');
  _studyInput.value = '';
  SqlEditor.refresh();
  document.querySelector('#study-answer-block').classList.remove('hidden');
  document.querySelector('#study-result-block').classList.add('hidden');
  const studyEvalBtn = document.querySelector('#study-eval-btn');
  studyEvalBtn.disabled = false;
  studyState.currentEvalResult = null;
  studyState.currentEvalContext = null;
  studyState.currentDecision = null;
  // Reset SQL compiler panel for study session
  const studyCompilerPanel = document.querySelector('#study-sql-compiler');
  const studyCompilerOut   = document.querySelector('#study-compiler-output');
  if (studyCompilerOut) { studyCompilerOut.className = 'sql-compiler-output hidden'; studyCompilerOut.textContent = ''; }

  // Start timer
  if (studyState.timerInterval) clearInterval(studyState.timerInterval);
  studyState.cardStartTime = Date.now();
  studyState.responseTimeMs = 0;
  const timerEl = document.querySelector('#study-timer');
  timerEl.textContent = '0s';
  studyState.timerInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - studyState.cardStartTime) / 1000);
    timerEl.textContent = `${elapsed}s`;
  }, 1000);

  // Update subject for dictation (attached once in initStudyTab)
  const subject = item.type === 'micro' ? item.data.parent_subject : item.data.subject;
  document.querySelector('#study-dictation-btn').dataset.subject = subject || '';

  // Math Palette + SQL Editor — use saved mode, explicit only (no auto-detect)
  // Micro-cards are always plain text regardless of subject mode
  const studyAnswerInput = document.querySelector('#study-answer-input');
  MathPalette.setActiveTextarea(studyAnswerInput);
  const savedMode   = getSubjectMode(subject);
  const isMicro     = item.type === 'micro';
  const studySqlMode = !isMicro && savedMode === 'sql';
  studyState.currentInputMode = !isMicro && savedMode === 'math' ? 'math' : studySqlMode ? 'sql' : '';

  if (!isMicro && savedMode === 'math') {
    MathPalette.show();
    SqlEditor.deactivate();
  } else if (studySqlMode) {
    MathPalette.hide();
    SqlEditor.activate(studyAnswerInput);
  } else {
    MathPalette.updateSubject(subject || '');
    SqlEditor.deactivate();
  }

  // Show SQL compiler panel (optional, never blocks eval button)
  if (studyCompilerPanel) {
    if (studySqlMode) {
      studyCompilerPanel.classList.remove('hidden');
    } else {
      studyCompilerPanel.classList.add('hidden');
    }
  }
  studyEvalBtn.disabled = false; // verification is always optional

  // ── Mode toggle button (non-micro cards only) ──────────────────────────────
  const modeToggleBtn = document.querySelector('#study-mode-toggle');
  if (modeToggleBtn) {
    const MODE_CYCLE  = ['', 'sql', 'math'];
    const MODE_LABELS = { '': 'Texto', 'sql': 'SQL/PL', 'math': 'Math' };
    if (isMicro) {
      modeToggleBtn.hidden = true;
    } else {
      modeToggleBtn.hidden = false;
      modeToggleBtn.textContent = MODE_LABELS[savedMode] || MODE_LABELS[''];
      modeToggleBtn.onclick = () => {
        const cur  = getSubjectMode(subject);
        const idx  = MODE_CYCLE.indexOf(cur);
        const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
        saveSubjectMode(subject, next);
        modeToggleBtn.textContent = MODE_LABELS[next];
        const input = document.querySelector('#study-answer-input');
        const panel = document.querySelector('#study-sql-compiler');
        MathPalette.setActiveTextarea(input);
        if (next === 'sql') {
          studyState.currentInputMode = 'sql';
          MathPalette.hide();
          SqlEditor.activate(input);
          panel?.classList.remove('hidden');
        } else if (next === 'math') {
          studyState.currentInputMode = 'math';
          SqlEditor.deactivate();
          MathPalette.show();
          panel?.classList.add('hidden');
        } else {
          studyState.currentInputMode = '';
          SqlEditor.deactivate();
          MathPalette.updateSubject(subject || '');
          panel?.classList.add('hidden');
        }
      };
    }
  }

  // ── Flag / report button ───────────────────────────────────────────────────
  const flagBtn = document.querySelector('#study-flag-btn');
  if (flagBtn) {
    flagBtn.hidden = false;
    flagBtn.onclick = () => {
      const note = prompt('Comentario (opcional):') ?? '';
      const cardId   = item.type === 'card'  ? item.data.id : null;
      const microId  = item.type === 'micro' ? item.data.id : null;
      if (cardId || microId) {
        const path = cardId ? `/cards/${cardId}/flag` : `/micro-cards/${microId}/flag`;
        postJson(path, { notes: note || 'duplicada' }).catch(() => {});
      }
      // Skip this card immediately in the current session
      studyState.queue.splice(studyState.index, 1);
      const total = studyState.queue.length;
      if (studyState.index >= total) studyState.index = Math.max(0, total - 1);
      showStudyCard();
    };
  }
}

function toggleStudyPromptEdit() {
  const item = studyState.queue[studyState.index];
  if (!item) return;

  const promptEl = document.querySelector('#study-card-prompt');
  const editBtn = document.querySelector('#study-edit-prompt-btn');
  const isEditing = promptEl?.getAttribute('contenteditable') === 'true';
  if (!promptEl || !editBtn) return;

  if (!isEditing) {
    promptEl.setAttribute('contenteditable', 'true');
    promptEl.focus();
    editBtn.textContent = 'Guardar edición';
    setStudyPromptFeedback('Editá el texto de la consigna y guardá.', 'info');
    return;
  }

  promptEl.removeAttribute('contenteditable');
  const editedPrompt = (promptEl.textContent || '').trim();
  if (editedPrompt.length < 10) {
    setStudyPromptFeedback('La consigna editada debe tener al menos 10 caracteres.', 'error');
    return;
  }

  if (item.type === 'micro') item.data.session_question = editedPrompt;
  else item.data.session_prompt_text = editedPrompt;

  promptEl.textContent = editedPrompt;
  editBtn.textContent = 'Editar';
  setStudyPromptFeedback('Consigna actualizada para esta sesión.', 'success');
}

async function clarifyStudyPrompt() {
  const item = studyState.queue[studyState.index];
  if (!item) return;

  const clarifyBtn = document.querySelector('#study-clarify-prompt-btn');
  const promptEl = document.querySelector('#study-card-prompt');
  const promptText = getStudyPromptText(item).trim();
  if (!clarifyBtn || !promptEl || promptText.length < 10) return;

  clarifyBtn.disabled = true;
  const previousText = clarifyBtn.textContent;
  clarifyBtn.textContent = 'Aclarando...';
  setStudyPromptFeedback('Generando versión más clara...', 'info');

  try {
    const data = await postJson('/prompts/clarify', { prompt_text: promptText });
    const clarifiedPrompt = (data.clarified_prompt || '').trim();
    if (clarifiedPrompt.length < 10) throw new Error('No se pudo generar una versión clara de la consigna.');

    if (item.type === 'micro') item.data.session_question = clarifiedPrompt;
    else item.data.session_prompt_text = clarifiedPrompt;

    promptEl.removeAttribute('contenteditable');
    promptEl.textContent = clarifiedPrompt;
    const editBtn = document.querySelector('#study-edit-prompt-btn');
    if (editBtn) editBtn.textContent = 'Editar';
    setStudyPromptFeedback('Consigna aclarada con IA para esta sesión.', 'success');
  } catch (err) {
    setStudyPromptFeedback(`No se pudo aclarar: ${err.message}`, 'error');
  } finally {
    clarifyBtn.disabled = false;
    clarifyBtn.textContent = previousText;
  }
}

// Study-session SQL verify button
const _studyVerifyBtn = document.querySelector('#study-verify-btn');
if (_studyVerifyBtn) {
  _studyVerifyBtn.addEventListener('click', async function () {
    const sql = (document.querySelector('#study-answer-input').value || '').trim();
    if (!sql) return;
    const out = document.querySelector('#study-compiler-output');
    const evalBtn = document.querySelector('#study-eval-btn');
    _studyVerifyBtn.disabled = true;
    await verifySql(sql, out);
    _studyVerifyBtn.disabled = false;
    // eval button is never blocked — verification is informational only
  });
}

document.querySelector('#study-eval-btn').addEventListener('click', async () => {
  const item     = studyState.queue[studyState.index];
  const answer   = document.querySelector('#study-answer-input').value.trim();
  const evalBtn  = document.querySelector('#study-eval-btn');

  if (!answer) return;

  // Stop timer and record response time
  if (studyState.timerInterval) {
    clearInterval(studyState.timerInterval);
    studyState.timerInterval = null;
  }
  studyState.responseTimeMs = Date.now() - studyState.cardStartTime;

  evalBtn.disabled = true;
  evalBtn.textContent = 'Evaluando...';

  let prompt_text, expected_answer_text, subject;

  if (item.type === 'micro') {
    prompt_text          = getStudyPromptText(item);
    expected_answer_text = item.data.expected_answer;
    subject              = item.data.parent_subject;
  } else {
    prompt_text          = getStudyPromptText(item);
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
    studyState.currentExpectedAnswer = expected_answer_text;
    studyState.currentEvalContext = {
      prompt_text,
      user_answer_text: answer,
      expected_answer_text,
      subject: subject || ''
    };
    studyState.currentDecision = null;

    const gradeEl    = document.querySelector('#study-result-grade');
    const justEl     = document.querySelector('#study-result-justification');
    const missingEl  = document.querySelector('#study-result-missing');
    const expectedEl = document.querySelector('#study-result-expected');
    const grade      = normalizeSuggestedGrade(result.suggested_grade);

    gradeEl.textContent = getSuggestedGradeLabel(result.suggested_grade);
    gradeEl.className   = `study-grade-inline ${grade.toLowerCase()}`;
    justEl.textContent  = result.justification_short;

    const timeEl = document.querySelector('#study-result-time');
    if (timeEl) {
      const elapsed = Math.round((studyState.responseTimeMs || 0) / 1000);
      timeEl.textContent = `${elapsed}s`;
    }

    // Replicate Evaluate-style dimension feedback in Study
    let dimsEl = document.querySelector('#study-result-dimensions');
    if (!dimsEl) {
      dimsEl = document.createElement('div');
      dimsEl.id = 'study-result-dimensions';
      dimsEl.className = 'study-result-dimensions';
      justEl.insertAdjacentElement('afterend', dimsEl);
    }
    const weakDimensions = Object.entries(result.dimensions || {})
      .filter(([, value]) => Number(value) < 0.7)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    if (weakDimensions.length > 0) {
      dimsEl.innerHTML = weakDimensions.map(([dimension, value]) => {
        const pct = Math.round(Number(value) * 100);
        const label = DIM_LABELS[dimension] || dimension;
        return `<span class="study-dimension-chip weak">${label}: ${pct}%</span>`;
      }).join('');
      dimsEl.classList.remove('hidden');
    } else {
      dimsEl.innerHTML = '<span class="study-dimension-chip ok">Buen dominio general en esta respuesta.</span>';
      dimsEl.classList.remove('hidden');
    }

    const concepts = result.missing_concepts ?? [];
    if (concepts.length > 0) {
      missingEl.innerHTML = `<strong>Faltó:</strong> ${concepts.map((c) => `<span class="concept-tag">${c}</span>`).join(' ')}`;
      missingEl.classList.remove('hidden');
    } else {
      missingEl.textContent = '';
      missingEl.classList.add('hidden');
    }

    // Always show answer comparison so the user can contrast their response with the expected one.
    if (grade === 'FAIL' || grade === 'REVIEW' || grade === 'PASS') {
      expectedEl.innerHTML = `
        ${formatAnswerBlock('Tu respuesta', answer)}
        ${formatAnswerBlock('Respuesta esperada', expected_answer_text)}
      `;
      expectedEl.classList.remove('hidden');
    } else {
      expectedEl.textContent = '';
      expectedEl.classList.add('hidden');
    }

    // SQL clause checklist in study result block
    let studySqlChecklist = document.querySelector('#study-sql-clause-checklist');
    if (studySqlChecklist) studySqlChecklist.remove();
    if (SqlEditor.isActive() && studyState.currentExpectedAnswer) {
      const clauses = SqlEditor.checkClauses(answer, studyState.currentExpectedAnswer);
      if (clauses.length > 0) {
        studySqlChecklist = document.createElement('div');
        studySqlChecklist.id = 'study-sql-clause-checklist';
        studySqlChecklist.innerHTML = renderClauseChecklist(clauses);
        const resultBlock = document.querySelector('#study-result-block');
        const actionsEl = resultBlock.querySelector('.study-result-actions');
        if (actionsEl) {
          resultBlock.insertBefore(studySqlChecklist, actionsEl);
        } else {
          resultBlock.appendChild(studySqlChecklist);
        }
      }
    }

    // Show "Guardar variante" for any regular card (not micro), regardless of grade
    const variantBtn      = document.querySelector('#study-variant-btn');
    const variantFeedback = document.querySelector('#study-variant-feedback');
    const nextBtn         = document.querySelector('#study-next-btn');
    const decisionBlock   = document.querySelector('#study-decision-block');
    const decisionFb      = document.querySelector('#study-decision-feedback');
    const decisionReason  = document.querySelector('#study-correction-reason');
    const currentItem = studyState.queue[studyState.index];
    if (currentItem && currentItem.type === 'card') {
      variantBtn.classList.remove('hidden');
      variantBtn.disabled = false;
      variantBtn.textContent = '+ Guardar variante';
    } else {
      variantBtn.classList.add('hidden');
    }
    variantFeedback.classList.add('hidden');
    variantFeedback.textContent = '';
    nextBtn.disabled = true;

    if (decisionReason) decisionReason.value = '';
    if (decisionFb) {
      decisionFb.textContent = 'Firmá esta evaluación para continuar.';
      decisionFb.className = 'feedback';
    }
    if (decisionBlock) {
      decisionBlock.classList.remove('hidden');
      decisionBlock.querySelectorAll('button').forEach((btn) => { btn.disabled = false; });
      const archiveBtn = decisionBlock.querySelector('#study-archive-card-btn');
      if (archiveBtn) archiveBtn.hidden = !currentItem || currentItem.type !== 'card';
    }

    document.querySelector('#study-answer-block').classList.add('hidden');
    document.querySelector('#study-result-block').classList.remove('hidden');
  } catch (err) {
    evalBtn.disabled = false;
    evalBtn.textContent = 'Evaluar';
    alert(`Error al evaluar: ${err.message}`);
  }
});

function resolveStudyFinalGrade(action, suggestedGrade) {
  const normalizedSuggested = normalizeSuggestedGrade(suggestedGrade);
  if (action === 'correct-pass') return 'PASS';
  if (action === 'correct-fail') return 'FAIL';
  if (action === 'accept') return normalizedSuggested;
  return null;
}

async function archiveCurrentStudyCard(reason) {
  const currentItem = studyState.queue[studyState.index];
  if (!currentItem || currentItem.type !== 'card') {
    throw new Error('Solo se pueden archivar tarjetas principales.');
  }
  if (!reason || reason.length < 5) {
    throw new Error('Indicá un motivo de al menos 5 caracteres para archivar.');
  }

  await postJson(`/cards/${currentItem.data.id}/archive`, { reason }, 'PATCH');
}

const studyDecisionBlock = document.querySelector('#study-decision-block');
if (studyDecisionBlock) {
  studyDecisionBlock.addEventListener('click', async (event) => {
    const action = event.target?.dataset?.studyAction;
    if (!action || !studyState.currentEvalResult || !studyState.currentEvalContext) return;

    const feedbackEl = document.querySelector('#study-decision-feedback');
    const reasonEl = document.querySelector('#study-correction-reason');
    const nextBtn = document.querySelector('#study-next-btn');
    const reason = normalize(reasonEl?.value || '');
    const finalGrade = resolveStudyFinalGrade(action, studyState.currentEvalResult.suggested_grade);
    const isArchiveAction = action === 'archive-card';

    const payload = {
      ...studyState.currentEvalContext,
      evaluation_id: studyState.currentEvalResult.evaluation_id,
      evaluation_result: studyState.currentEvalResult,
      action,
      final_grade: finalGrade,
      accepted_suggestion: action === 'accept',
      correction_reason: reason || undefined
    };

    studyDecisionBlock.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
    if (feedbackEl) {
      feedbackEl.textContent = isArchiveAction ? 'Archivando tarjeta...' : 'Guardando firma...';
      feedbackEl.className = 'feedback';
    }

    try {
      if (isArchiveAction) {
        await archiveCurrentStudyCard(reason);
      } else {
        await postJson(DECISION_ENDPOINT, payload);
      }
      studyState.currentDecision = {
        action,
        finalGrade: finalGrade ? finalGrade.toLowerCase() : null
      };
      if (feedbackEl) {
        feedbackEl.textContent = isArchiveAction
          ? 'Tarjeta archivada. Ya podés continuar.'
          : (finalGrade
            ? `Firma guardada (${finalGrade}). Ya podés continuar.`
            : 'Firma guardada como duda. Ya podés continuar.');
        feedbackEl.className = 'feedback success';
      }
      nextBtn.disabled = false;
    } catch (err) {
      if (feedbackEl) {
        feedbackEl.textContent = isArchiveAction
          ? `No se pudo archivar la tarjeta: ${err.message}`
          : `No se pudo guardar la firma: ${err.message}`;
        feedbackEl.className = 'feedback error';
      }
      studyDecisionBlock.querySelectorAll('button').forEach((btn) => { btn.disabled = false; });
    }
  });
}

document.querySelector('#study-variant-btn').addEventListener('click', async () => {
  const item = studyState.queue[studyState.index];
  const variantBtn  = document.querySelector('#study-variant-btn');
  const variantFb   = document.querySelector('#study-variant-feedback');
  if (!item || item.type !== 'card') return;

  variantBtn.disabled = true;
  variantBtn.textContent = 'Generando...';
  variantFb.classList.add('hidden');

  try {
    await postJson(`/scheduler/cards/${item.data.id}/variant`, {});
    variantBtn.classList.add('hidden');
    variantFb.textContent = 'Variante guardada. Aparecerá en futuras revisiones.';
    variantFb.style.color = 'var(--pass-fg)';
    variantFb.classList.remove('hidden');
  } catch (err) {
    variantBtn.disabled = false;
    variantBtn.textContent = '+ Guardar variante';
    variantFb.textContent = `Error: ${err.message}`;
    variantFb.style.color = 'var(--fail-fg)';
    variantFb.classList.remove('hidden');
  }
});

document.querySelector('#study-next-btn').addEventListener('click', async () => {
  const item   = studyState.queue[studyState.index];
  const evalResult = studyState.currentEvalResult;
  const decision = studyState.currentDecision;
  if (!evalResult) { advanceStudyCard(); return; }
  if (!decision) {
    const feedbackEl = document.querySelector('#study-decision-feedback');
    if (feedbackEl) {
      feedbackEl.textContent = 'Firmá esta evaluación antes de pasar a la siguiente.';
      feedbackEl.className = 'feedback error';
    }
    return;
  }

  const grade  = decision.finalGrade;
  const gaps   = evalResult.missing_concepts ?? [];

  try {
    if (!grade) {
      // uncertain: skip scheduler update for this response
    } else if (item.type === 'micro') {
      await postJson('/scheduler/review', {
        micro_card_id: item.data.id,
        grade,
        response_time_ms: studyState.responseTimeMs || undefined
      });
    } else {
      const reviewResp = await postJson('/scheduler/review', {
        card_id: item.data.id,
        grade,
        concept_gaps: gaps,
        response_time_ms: studyState.responseTimeMs || undefined
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
    grade: grade || 'uncertain',
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
  if (studyState.timerInterval) {
    clearInterval(studyState.timerInterval);
    studyState.timerInterval = null;
  }
  // Update progress bar to 100%
  document.querySelector('#study-progress-fill').style.width = '100%';

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
  const res = await fetch(url, {
    headers: Auth.getToken() ? { 'Authorization': 'Bearer ' + Auth.getToken() } : {}
  });
  Auth.handleRefreshToken(res);
  if (res.status === 401) { if (Auth.isLoggedIn()) Auth.logout(); return null; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Agenda view ──────────────────────────────────────────────────────────────

const BUCKET_LABELS = {
  overdue:   'Advertencia: Vencidas',
  today:     'Hoy',
  tomorrow:  'Mañana',
  this_week: 'Esta semana',
  two_weeks: 'Próximas 2 semanas',
  later:     'Más adelante'
};

async function loadAgenda() {
  const agendaEl  = document.querySelector('#study-agenda');
  const summaryEl = document.querySelector('#agenda-summary');
  const bucketsEl = document.querySelector('#agenda-buckets');

  document.querySelector('#study-add-form').classList.add('hidden');
  agendaEl.classList.remove('hidden');
  summaryEl.innerHTML = '<span style="color:#888">Cargando...</span>';
  bucketsEl.innerHTML = '';

  try {
    const data = await getJson('/scheduler/agenda');
    const s = data.summary;

    summaryEl.innerHTML = `
      <div class="agenda-pills">
        ${s.overdue      ? `<span class="agenda-pill overdue">${s.overdue} vencida${s.overdue !== 1 ? 's' : ''}</span>` : ''}
        ${s.due_today    ? `<span class="agenda-pill today">${s.due_today} hoy</span>` : ''}
        ${s.due_tomorrow ? `<span class="agenda-pill soon">${s.due_tomorrow} mañana</span>` : ''}
        <span class="agenda-pill neutral">${s.total_cards} tarjeta${s.total_cards !== 1 ? 's' : ''} total</span>
        ${s.active_micro_cards ? `<span class="agenda-pill micro">${s.active_micro_cards} micro-concepto${s.active_micro_cards !== 1 ? 's' : ''} activo${s.active_micro_cards !== 1 ? 's' : ''}</span>` : ''}
      </div>
    `;

    bucketsEl.innerHTML = '';

    for (const [key, label] of Object.entries(BUCKET_LABELS)) {
      const cards = data.buckets[key] ?? [];
      if (!cards.length) continue;

      const section = document.createElement('div');
      section.className = 'agenda-bucket';
      section.innerHTML = `<h4 class="agenda-bucket-title ${key}">${label} <span class="agenda-bucket-count">${cards.length}</span></h4>`;

      for (const card of cards) {
        const micros = card.micro_cards ?? [];
        const due = new Date(card.next_review_at);
        const dueStr = formatDue(due);
        const intervalStr = card.interval_days >= 1
          ? `cada ${Math.round(card.interval_days)} día${Math.round(card.interval_days) !== 1 ? 's' : ''}`
          : 'mañana';

        const cardEl = document.createElement('div');
        cardEl.className = 'agenda-card';
        cardEl.innerHTML = `
          <div class="agenda-card-header">
            ${card.subject ? `<span class="agenda-subject-badge">${card.subject}</span>` : ''}
            <span class="agenda-due ${key}">${dueStr}</span>
            <span class="agenda-interval">${intervalStr} · ${card.review_count} revis. · ${card.pass_count} ok</span>
          </div>
          <p class="agenda-card-prompt">${truncate(card.prompt_text, 120)}</p>
          ${micros.length ? `
            <div class="agenda-micros">
              ${micros.map((m) => `
                <div class="agenda-micro-item">
                  <span class="concept-tag">${m.concept}</span>
                  <span class="agenda-micro-due">${formatDue(new Date(m.next_review_at))}</span>
                  <span class="agenda-micro-q">${truncate(m.question, 80)}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        `;
        section.appendChild(cardEl);
      }

      bucketsEl.appendChild(section);
    }

    if (!bucketsEl.children.length) {
      bucketsEl.innerHTML = '<p style="color:#888;padding:12px 0">No hay tarjetas registradas aún.</p>';
    }
  } catch (err) {
    summaryEl.innerHTML = `<span style="color:#c00">Error: ${err.message}</span>`;
  }
}

function formatDue(date) {
  const now    = new Date();
  const diffMs = date - now;
  const diffD  = Math.round(diffMs / 86400000);

  if (diffD < 0)  return `hace ${Math.abs(diffD)} día${Math.abs(diffD) !== 1 ? 's' : ''}`;
  if (diffD === 0) return 'hoy';
  if (diffD === 1) return 'mañana';
  if (diffD < 7)  return `en ${diffD} días`;
  if (diffD < 14) return `en ${Math.round(diffD / 7)} semana`;
  return `en ${diffD} días`;
}

function truncate(str, max) {
  return str && str.length > max ? str.slice(0, max) + '…' : str;
}

// ─── Curriculum modal ─────────────────────────────────────────────────────────

async function openCurriculumModal(subject) {
  document.querySelector('#curriculum-modal-title').textContent = `Configurar: ${subject}`;
  document.querySelector('#curriculum-modal').classList.remove('hidden');
  document.querySelector('#curriculum-save-feedback').textContent = '';
  document.querySelector('#exam-add-feedback').textContent = '';
  document.querySelector('#exam-date-feedback').textContent = '';

  // Load existing config
  try {
    const data = await getJson(`/curriculum/${encodeURIComponent(subject)}`);
    document.querySelector('#curriculum-syllabus').value = data.config?.syllabus_text || '';
    renderExamDatesList(data.exam_dates || [], subject);
    renderExamsList(data.exams || [], subject);
  } catch (_e) {}

  // Store current subject in modal
  document.querySelector('#curriculum-modal').dataset.subject = subject;
}

document.querySelector('#curriculum-modal-close').addEventListener('click', () => {
  document.querySelector('#curriculum-modal').classList.add('hidden');
});

document.querySelector('.curriculum-modal-backdrop').addEventListener('click', () => {
  document.querySelector('#curriculum-modal').classList.add('hidden');
});

document.querySelector('#curriculum-save-btn').addEventListener('click', async () => {
  const subject = document.querySelector('#curriculum-modal').dataset.subject;
  const fb = document.querySelector('#curriculum-save-feedback');
  try {
    await postJson(`/curriculum/${encodeURIComponent(subject)}`, {
      syllabus_text: document.querySelector('#curriculum-syllabus').value
    }, 'PUT');
    fb.textContent = 'Guardado.';
    fb.style.color = 'var(--pass-fg)';
  } catch (err) {
    fb.textContent = `Error: ${err.message}`;
    fb.style.color = 'var(--fail-fg)';
  }
});

// ── Exam dates (múltiples por materia) ────────────────────────────────────────

document.querySelector('#exam-date-add-btn').addEventListener('click', async () => {
  const subject = document.querySelector('#curriculum-modal').dataset.subject;
  const fb    = document.querySelector('#exam-date-feedback');
  const label = document.querySelector('#new-exam-label').value.trim();
  const date  = document.querySelector('#new-exam-date').value;
  const type  = document.querySelector('#new-exam-type').value;
  const scope = parseInt(document.querySelector('#new-exam-scope').value, 10);

  if (!label) { fb.textContent = 'El nombre del examen es obligatorio.'; fb.style.color = 'var(--fail-fg)'; return; }
  if (!date)  { fb.textContent = 'La fecha es obligatoria.'; fb.style.color = 'var(--fail-fg)'; return; }
  if (!scope || scope < 1 || scope > 100) { fb.textContent = 'El % debe ser entre 1 y 100.'; fb.style.color = 'var(--fail-fg)'; return; }

  try {
    const data = await postJson(`/curriculum/${encodeURIComponent(subject)}/exam-dates`, {
      label, exam_date: date, exam_type: type, scope_pct: scope
    });
    fb.textContent = 'Fecha agregada.';
    fb.style.color = 'var(--pass-fg)';
    document.querySelector('#new-exam-label').value = '';
    document.querySelector('#new-exam-date').value  = '';
    document.querySelector('#new-exam-scope').value = '50';
    renderExamDatesList(data.exam_dates, subject);
  } catch (err) {
    fb.textContent = `Error: ${err.message}`;
    fb.style.color = 'var(--fail-fg)';
  }
});

function renderExamDatesList(examDates, subject) {
  const el = document.querySelector('#exam-dates-list');
  if (!examDates.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;margin:0 0 4px">Sin fechas cargadas.</p>';
    return;
  }
  const now = new Date();
  el.innerHTML = examDates.map(e => {
    const dDate = new Date(e.exam_date + 'T00:00:00');
    const days  = Math.ceil((dDate - now) / 86400000);
    const past  = days < 0;
    const badge = past
      ? `<span class="exam-date-badge">pasado</span>`
      : days <= 7
        ? `<span class="exam-date-badge urgent">${days}d</span>`
        : `<span class="exam-date-badge far">${days}d</span>`;
    const scopeTag = `<span style="font-size:0.75rem;color:var(--text-muted)">${e.scope_pct}% temario</span>`;
    return `
      <div class="exam-date-item">
        <span class="exam-date-label">${escHtml(e.label)}</span>
        <span class="exam-date-meta">${e.exam_date?.slice(0,10)} · ${e.exam_type} · ${scopeTag}</span>
        ${badge}
        <button type="button" class="btn-ghost exam-date-delete-btn" data-id="${e.id}" data-subject="${escHtml(subject)}" style="font-size:0.72rem;padding:1px 7px">Eliminar</button>
      </div>`;
  }).join('');

  el.querySelectorAll('.exam-date-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const subj = btn.dataset.subject;
      try {
        const data = await deleteJson(`/curriculum/${encodeURIComponent(subj)}/exam-dates/${btn.dataset.id}`);
        renderExamDatesList(data.exam_dates || [], subj);
      } catch (_e) {}
    });
  });
}

// ── Reference exams (historial) ───────────────────────────────────────────────

document.querySelector('#exam-add-btn').addEventListener('click', async () => {
  const subject = document.querySelector('#curriculum-modal').dataset.subject;
  const fb = document.querySelector('#exam-add-feedback');
  const content = document.querySelector('#exam-content').value.trim();
  if (!content) { fb.textContent = 'El contenido es obligatorio.'; fb.style.color = 'var(--fail-fg)'; return; }
  try {
    const data = await postJson(`/curriculum/${encodeURIComponent(subject)}/exams`, {
      year: parseInt(document.querySelector('#exam-year').value) || null,
      label: document.querySelector('#exam-label').value.trim() || null,
      exam_type: document.querySelector('#exam-type-select').value,
      content_text: content
    });
    fb.textContent = 'Examen agregado.';
    fb.style.color = 'var(--pass-fg)';
    document.querySelector('#exam-content').value = '';
    document.querySelector('#exam-year').value = '';
    document.querySelector('#exam-label').value = '';
    renderExamsList(data.exams, subject);
  } catch (err) {
    fb.textContent = `Error: ${err.message}`;
    fb.style.color = 'var(--fail-fg)';
  }
});

function renderExamsList(exams, subject) {
  const el = document.querySelector('#curriculum-exams-list');
  if (!exams.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">Sin exámenes de referencia.</p>'; return; }
  el.innerHTML = exams.map(e => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="flex:1;font-size:0.85rem">${escHtml(e.label || e.exam_type)} ${e.year || ''}</span>
      <button type="button" class="btn-ghost exam-delete-btn" data-id="${e.id}" data-subject="${escHtml(subject)}" style="font-size:0.75rem;padding:2px 8px">Eliminar</button>
    </div>`).join('');

  el.querySelectorAll('.exam-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const subj = btn.dataset.subject;
      try {
        await deleteJson(`/curriculum/${encodeURIComponent(subj)}/exams/${btn.dataset.id}`);
        const data = await getJson(`/curriculum/${encodeURIComponent(subj)}`);
        renderExamsList(data.exams || [], subj);
      } catch (_e) {}
    });
  });
}

// ─── Advisor analysis ─────────────────────────────────────────────────────────

async function loadAdvisorAnalysis(subject) {
  const loading = document.querySelector('#advisor-loading');
  const content = document.querySelector('#advisor-content');
  loading.classList.remove('hidden');
  content.innerHTML = '';

  try {
    const data = await getJson(`/advisor/analysis/${encodeURIComponent(subject)}`);
    loading.classList.add('hidden');

    if (data.error === 'no_config') {
      content.innerHTML = `<p style="color:var(--text-muted)">Esta materia no tiene plan de estudios. Configurala desde el Dashboard (⚙ Configurar).</p>`;
      return;
    }

    const paceColor = data.pace_ok ? 'var(--pass-fg)' : 'var(--fail-fg)';
    const coveragePct = Math.round(data.coverage_pct || 0);

    content.innerHTML = `
      <div class="advisor-summary">${data.summary}</div>

      <div class="advisor-section">
        <div class="advisor-label">Cobertura del programa</div>
        <div class="dimension-bar-track" style="margin:6px 0">
          <div class="dimension-bar-fill${coveragePct < 40 ? ' weak' : coveragePct < 70 ? ' mid' : ''}" style="width:${coveragePct}%"></div>
        </div>
        <span style="font-size:0.85rem">${coveragePct}%</span>
      </div>

      ${data.days_until_exam != null ? `
      <div class="advisor-section">
        <div class="advisor-label">Examen</div>
        <div style="font-size:1.1rem;font-weight:700;color:${paceColor}">${data.days_until_exam} días</div>
        <div style="font-size:0.85rem;color:var(--text-muted);margin-top:2px">${data.pace_message}</div>
      </div>` : ''}

      ${data.priorities?.length ? `
      <div class="advisor-section">
        <div class="advisor-label">Prioridades</div>
        <ol class="advisor-list">${data.priorities.map(p => `<li>${p}</li>`).join('')}</ol>
      </div>` : ''}

      ${data.exam_gaps?.length ? `
      <div class="advisor-section">
        <div class="advisor-label">Gaps detectados en exámenes anteriores</div>
        <ul class="advisor-list">${data.exam_gaps.map(g => `<li>${g}</li>`).join('')}</ul>
      </div>` : ''}

      ${data.missing_topics?.length ? `
      <div class="advisor-section">
        <div class="advisor-label">Temas sin cubrir</div>
        <div class="advisor-tags">${data.missing_topics.map(t => `<span class="advisor-tag missing">${t}</span>`).join('')}</div>
      </div>` : ''}

      ${data.covered_topics?.length ? `
      <div class="advisor-section">
        <div class="advisor-label">Temas cubiertos</div>
        <div class="advisor-tags">${data.covered_topics.map(t => `<span class="advisor-tag covered">${t}</span>`).join('')}</div>
      </div>` : ''}
    `;
  } catch (err) {
    loading.classList.add('hidden');
    content.innerHTML = `<p style="color:var(--fail-fg)">Error al analizar: ${err.message}</p>`;
  }
}
