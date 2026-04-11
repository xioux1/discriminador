const EVALUATE_ENDPOINT = '/evaluate';
const DECISION_ENDPOINT = '/decision';
let pendingStudySubject = null;
const advisorCoverageCache = new Map();

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
    browser:   document.querySelector('#tab-browser'),
    planner:   document.querySelector('#tab-planner'),
    progress:  document.querySelector('#tab-progress'),
  };
  let loaded = { dashboard: false, study: false, explore: false, browser: false, planner: false, progress: false };

  function showTab(tab) {
    Object.values(tabSections).forEach((s) => s.classList.add('hidden'));
    if (tabSections[tab]) tabSections[tab].classList.remove('hidden');
  }

  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      const fromDashboard = tab === 'study' && btn.dataset.subjectFromDashboard !== undefined;
      if (fromDashboard) {
        pendingStudySubject = btn.dataset.subjectFromDashboard || '';
        delete btn.dataset.subjectFromDashboard;
      } else if (tab === 'study') {
        pendingStudySubject = null;
      }
      showTab(tab);

      if (tab === 'explore' && !loaded.explore) {
        loaded.explore = true; loadHistoryOverview();
      } else if (tab === 'browser' && !loaded.browser) {
        loaded.browser = true; initBrowserTab();
      } else if (tab === 'study' && !loaded.study) {
        loaded.study = true; initStudyTab();
        applyStudySubjectFilter(pendingStudySubject);
      } else if (tab === 'study') {
        applyStudySubjectFilter(pendingStudySubject);
      } else if (tab === 'dashboard' && !loaded.dashboard) {
        loaded.dashboard = true; loadDashboard();
      } else if (tab === 'planner' && !loaded.planner) {
        loaded.planner = true; initPlannerTab();
      } else if (tab === 'planner') {
        // already loaded — just show
      } else if (tab === 'progress' && !loaded.progress) {
        loaded.progress = true; loadProgress();
      }

      // Dashboard "Estudiar" subject button → skip briefing, go straight to the
      // subject-filtered overview so the user can start reviewing immediately.
      if (tab === 'study' && fromDashboard && briefingState.selectedSubject) {
        const sessionEl = document.querySelector('#study-session');
        if (sessionEl && sessionEl.classList.contains('hidden')) {
          document.querySelector('#study-briefing').classList.add('hidden');
          document.querySelector('#study-complete').classList.add('hidden');
          document.querySelector('#study-overview').classList.remove('hidden');
          loadStudyOverview();
        }
      }
    });
  });

  // Show dashboard on load
  showTab('dashboard');
  loaded.dashboard = true;
  loadDashboard();
})();

initNotes();

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
          <span class="history-question-prompt">${escHtml(q.prompt_text.length > 120 ? q.prompt_text.slice(0, 120) + '…' : q.prompt_text)}</span>
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
                    ${item.justification ? `<span style="color:#555;font-size:0.82rem">${escHtml(item.justification)}</span>` : ''}
                    ${item.correction_reason ? `<span style="color:#888;font-size:0.8rem">[corrección: ${escHtml(item.correction_reason)}]</span>` : ''}`;
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

const browserState = {
  cards: [],
  selected: new Set()
};

function getCardStatus(card) {
  if (card.suspended_at) return 'suspended';
  if (card.flagged) return 'flagged';
  if (Number(card.review_count) === 0) return 'new';
  const dueAt = card.next_review_at ? new Date(card.next_review_at) : null;
  return dueAt && dueAt <= new Date() ? 'due' : 'new';
}

function formatNextReview(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

function getBrowserFilters() {
  return {
    text: document.querySelector('#browser-filter-text')?.value.trim().toLowerCase() || '',
    subject: document.querySelector('#browser-filter-subject')?.value.trim().toLowerCase() || '',
    status: document.querySelector('#browser-filter-status')?.value || ''
  };
}

function getFilteredBrowserCards() {
  const filters = getBrowserFilters();
  return browserState.cards.filter((card) => {
    const status = getCardStatus(card);
    if (filters.status && status !== filters.status) return false;
    if (filters.text && !String(card.prompt_text || '').toLowerCase().includes(filters.text)) return false;
    if (filters.subject && !String(card.subject || '').toLowerCase().includes(filters.subject)) return false;
    return true;
  });
}

function renderBrowserTable() {
  const body = document.querySelector('#browser-table-body');
  if (!body) return;
  const rows = getFilteredBrowserCards();

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted)">No hay tarjetas para este filtro.</td></tr>';
    return;
  }

  body.innerHTML = rows.map((card) => {
    const status = getCardStatus(card);
    const lapses = Math.max(0, Number(card.review_count || 0) - Number(card.pass_count || 0));
    return `
      <tr>
        <td><input type="checkbox" class="browser-row-check" data-id="${card.id}" ${browserState.selected.has(card.id) ? 'checked' : ''}></td>
        <td>${escHtml(card.subject || '(sin materia)')}</td>
        <td class="browser-prompt">${escHtml(card.prompt_text || '')}</td>
        <td>${formatNextReview(card.next_review_at)}</td>
        <td><span class="browser-status-pill ${status}">${status}</span></td>
        <td>${lapses}</td>
        <td>${card.flagged ? '⚑' : ''}</td>
      </tr>
    `;
  }).join('');

  body.querySelectorAll('.browser-row-check').forEach((el) => {
    el.addEventListener('change', () => {
      const id = Number(el.dataset.id);
      if (el.checked) browserState.selected.add(id);
      else browserState.selected.delete(id);
    });
  });
}

async function loadBrowserCards() {
  const response = await getJson('/cards/browser');
  browserState.cards = response?.cards || [];
  browserState.selected.clear();
  renderBrowserTable();
}

async function runBrowserBatchAction(action) {
  const feedback = document.querySelector('#browser-feedback');
  const ids = [...browserState.selected];
  if (!ids.length) {
    feedback.textContent = 'Seleccioná al menos una tarjeta.';
    feedback.className = 'feedback error';
    return;
  }

  let payload = { action: action === 'reassign' ? 'edit' : action, ids };
  if (action === 'archive') {
    const reason = window.prompt('Motivo para archivar (mínimo 5 caracteres):', 'Archivado desde navegador');
    if (!reason) return;
    payload.reason = reason;
  } else if (action === 'reassign') {
    const subject = window.prompt(`Reasignar ${ids.length} tarjeta(s) a la materia:`, '');
    if (subject === null) return;
    if (!subject.trim()) {
      feedback.textContent = 'Ingresá el nombre de la materia destino.';
      feedback.className = 'feedback error';
      return;
    }
    payload.subject = subject.trim();
    payload.prompt_text = '';
  } else if (action === 'edit') {
    const promptText = window.prompt('Nuevo prompt para las seleccionadas (dejá vacío para no cambiar):', '');
    if (promptText === null) return;
    payload.subject = '';
    payload.prompt_text = promptText ?? '';
  }

  try {
    const result = await postJson('/cards/batch', payload);
    feedback.textContent = `Acción aplicada en ${result.updated ?? 0} tarjeta(s).`;
    feedback.className = 'feedback success';
    await loadBrowserCards();
  } catch (err) {
    feedback.textContent = `Error: ${err.message}`;
    feedback.className = 'feedback error';
  }
}

function initBrowserTab() {
  const textEl = document.querySelector('#browser-filter-text');
  const subjectEl = document.querySelector('#browser-filter-subject');
  const statusEl = document.querySelector('#browser-filter-status');
  const selectAllEl = document.querySelector('#browser-select-all');
  const feedback = document.querySelector('#browser-feedback');
  feedback.textContent = '';

  [textEl, subjectEl, statusEl].forEach((el) => {
    el?.addEventListener('input', renderBrowserTable);
    el?.addEventListener('change', renderBrowserTable);
  });

  selectAllEl?.addEventListener('change', () => {
    const visibleIds = getFilteredBrowserCards().map((c) => c.id);
    if (selectAllEl.checked) visibleIds.forEach((id) => browserState.selected.add(id));
    else visibleIds.forEach((id) => browserState.selected.delete(id));
    renderBrowserTable();
  });

  document.querySelector('#browser-reassign-btn')?.addEventListener('click', () => runBrowserBatchAction('reassign'));
  document.querySelector('#browser-add-card-btn')?.addEventListener('click', () => {
    const form = document.querySelector('#study-add-form');
    const isHidden = form.classList.contains('hidden');
    form.classList.toggle('hidden', !isHidden);
    if (isHidden) {
      const subjectFilterValue = String(document.querySelector('#browser-filter-subject')?.value || '').trim();
      const subjectInput = document.querySelector('#card-subject');
      if (subjectInput && subjectFilterValue && !subjectInput.value.trim()) {
        subjectInput.value = subjectFilterValue;
      }
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  ensureAddCardFormHandlers();

  document.querySelector('#browser-archive-btn')?.addEventListener('click', () => runBrowserBatchAction('archive'));
  document.querySelector('#browser-suspend-btn')?.addEventListener('click', () => runBrowserBatchAction('suspend'));
  document.querySelector('#browser-reactivate-btn')?.addEventListener('click', () => runBrowserBatchAction('reactivate'));
  document.querySelector('#browser-edit-btn')?.addEventListener('click', () => runBrowserBatchAction('edit'));

  loadBrowserCards().catch((err) => {
    feedback.textContent = `Error al cargar navegador: ${err.message}`;
    feedback.className = 'feedback error';
  });
}

// --- Dashboard ---

async function getAdvisorCoverageBySubject(subjects = []) {
  const uniqueSubjects = [...new Set(subjects
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean))];

  const result = new Map();
  const missing = [];

  for (const subject of uniqueSubjects) {
    if (advisorCoverageCache.has(subject)) {
      result.set(subject, advisorCoverageCache.get(subject));
    } else {
      missing.push(subject);
    }
  }

  if (!missing.length) return result;

  const responses = await Promise.all(missing.map(async (subject) => {
    try {
      const data = await getJson(`/advisor/analysis/${encodeURIComponent(subject)}`);
      if (data?.error === 'no_config') return { subject, coverage: null };
      const coverage = Math.max(0, Math.min(100, Math.round(Number(data?.coverage_pct) || 0)));
      return { subject, coverage };
    } catch (_err) {
      return { subject, coverage: null };
    }
  }));

  responses.forEach(({ subject, coverage }) => {
    advisorCoverageCache.set(subject, coverage);
    result.set(subject, coverage);
  });

  return result;
}

async function renderExamCalendar(exams) {
  const card = document.createElement('div');
  card.className = 'card exam-calendar-card';

  const title = document.createElement('h3');
  title.className = 'exam-calendar-title';
  title.textContent = 'Próximos exámenes';
  card.appendChild(title);

  if (!exams || exams.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'font-size:0.85rem;color:var(--text-muted);margin:0';
    empty.textContent = 'No hay fechas de examen configuradas. Usá "Configurar" en cada materia para agregarlas.';
    card.appendChild(empty);
    return card;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  function parseExamDate(raw) {
    // Handle 'YYYY-MM-DD', 'YYYY-MM-DDT...' or Date objects
    const s = String(raw).slice(0, 10); // always take first 10 chars
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d); // local date, no timezone issues
  }

  // Show ALL exams (past only hidden after 30 days)
  const relevant = exams
    .map(e => ({ ...e, _d: parseExamDate(e.exam_date) }))
    .filter(e => Math.round((e._d - today) / 86400000) >= -30)
    .sort((a, b) => a._d - b._d);

  if (relevant.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'font-size:0.85rem;color:var(--text-muted);margin:0';
    empty.textContent = 'No hay exámenes próximos configurados.';
    card.appendChild(empty);
    return card;
  }

  const list = document.createElement('div');
  list.className = 'exam-calendar-list';

  for (const exam of relevant) {
    const d = exam._d;
    const diff = Math.round((d - today) / 86400000);

    // Urgency tiers — must match CSS .exam-urgency-* color system:
    // urgent (amber) ≤ 3d  ·  soon (olive) ≤ 14d  ·  later (neutral) > 14d
    let urgency, label;
    if (diff < 0)        { urgency = 'past';   label = `−${Math.abs(diff)}d`; }
    else if (diff === 0) { urgency = 'today';  label = 'HOY'; }
    else if (diff <= 3)  { urgency = 'urgent'; label = `${diff}d`; }
    else if (diff <= 14) { urgency = 'soon';   label = `${diff}d`; }
    else                 { urgency = 'later';  label = `${diff}d`; }

    const dayName = d.toLocaleDateString('es-AR', { weekday: 'short' });
    const dateStr = d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });

    const item = document.createElement('div');
    const scopePct = Math.max(0, Math.min(100, Number(exam.scope_pct) || 0));

    // Use cached coverage if available, otherwise show update button
    const cachedCoverage = advisorCoverageCache.has(exam.subject)
      ? Math.max(0, Math.min(100, Number(advisorCoverageCache.get(exam.subject)) || 0))
      : null;

    item.className = `exam-calendar-item exam-urgency-${urgency}`;
    item.innerHTML = `
      <div class="exam-cal-countdown">${label}</div>
      <div class="exam-cal-info">
        <span class="exam-cal-subject">${escHtml(exam.subject)}</span>
        <span class="exam-cal-label">${escHtml(exam.label)}</span>
      </div>
      <div class="exam-cal-date">${dayName} ${dateStr}</div>
      <div class="exam-cal-meta">
        <div class="exam-cal-metric">
          <div class="exam-cal-metric-track exam-cal-scope-track">
            <div class="exam-cal-metric-fill exam-cal-scope-fill" style="width:${scopePct}%"></div>
          </div>
          <div class="exam-cal-metric-text"><strong>${scopePct}%</strong> temario</div>
        </div>
        <div class="exam-cal-metric exam-cal-coverage" data-subject="${escHtml(exam.subject)}">
          ${cachedCoverage != null ? `
            <div class="exam-cal-metric-track exam-cal-coverage-track">
              <div class="exam-cal-metric-fill exam-cal-coverage-fill" style="width:${cachedCoverage}%"></div>
            </div>
            <div class="exam-cal-metric-text"><strong>${cachedCoverage}%</strong> cubierto</div>
          ` : `
            <button class="btn-update-coverage" data-subject="${escHtml(exam.subject)}">Actualizar %</button>
          `}
        </div>
      </div>
    `;
    list.appendChild(item);
  }

  // Delegate click on coverage update buttons
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-update-coverage');
    if (!btn) return;
    const subject = btn.dataset.subject;
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const data = await getJson(`/advisor/analysis/${encodeURIComponent(subject)}`);
      const coverage = (data?.error === 'no_config')
        ? null
        : Math.max(0, Math.min(100, Math.round(Number(data?.coverage_pct) || 0)));
      if (coverage != null) advisorCoverageCache.set(subject, coverage);
      const container = list.querySelector(`.exam-cal-coverage[data-subject="${CSS.escape(subject)}"]`);
      if (container) {
        container.innerHTML = coverage != null ? `
          <div class="exam-cal-metric-track exam-cal-coverage-track">
            <div class="exam-cal-metric-fill exam-cal-coverage-fill" style="width:${coverage}%"></div>
          </div>
          <div class="exam-cal-metric-text"><strong>${coverage}%</strong> cubierto</div>
        ` : `<span style="font-size:0.75rem;color:var(--text-muted)">Sin config</span>`;
      }
    } catch (_) {
      btn.disabled = false;
      btn.textContent = 'Actualizar %';
    }
  });

  card.appendChild(list);
  return card;
}

async function loadDashboard() {
  const loading = document.querySelector('#dashboard-loading');
  const content = document.querySelector('#dashboard-content');
  loading.classList.remove('hidden');
  content.innerHTML = '';

  try {
    const [overview, session, calendarData] = await Promise.all([
      getJson('/stats/overview').catch(() => ({ subjects: [] })),
      getJson('/scheduler/session').catch(() => ({ cards: [], micro_cards: [] })),
      getJson('/exam-calendar').catch(() => ({ exams: [] }))
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
      content.innerHTML = '<p style="color:var(--text-muted);padding:16px">Aún no hay tarjetas. Empezá agregando tarjetas en la pestaña Tarjetas.</p>';
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

    // Pending banner — compact stat row, neutral surface (no blue)
    {
      const banner = document.createElement('div');
      banner.className = 'dashboard-pending-banner card';
      if (totalDue > 0) {
        banner.textContent = `${totalDue} pendientes hoy (${totalPendingCards} tarjetas principales + ${totalActiveMicros} microconsignas).`;
      } else {
        banner.textContent = 'Sin pendientes hoy.';
      }
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

      const totalDueForSubject = (pendingMainCards || 0) + (activeMicros || 0);
      const metaParts = [];
      if (pendingMainCards > 0) metaParts.push(`${pendingMainCards} pend.`);
      if (activeMicros > 0) metaParts.push(`${activeMicros} micro${activeMicros !== 1 ? 's' : ''}`);
      const metaText = metaParts.join(' · ');

      const row = document.createElement('li');
      row.className = 'subjects-list-item';
      row.innerHTML = `
        <div class="subjects-list-beat ${totalDueForSubject > 0 ? 'has-due' : 'is-clear'}">
          ${totalDueForSubject > 0 ? totalDueForSubject : '●'}
        </div>
        <div class="subjects-list-main">
          <div class="subjects-list-name">${subjectName}</div>
          ${metaText ? `<div class="subjects-list-meta">${metaText}</div>` : ''}
        </div>
        <div class="subjects-list-actions">
          <button type="button" class="btn-secondary deck-study-btn" data-subject="${subjectName}">Estudiar</button>
          <button type="button" class="btn-secondary deck-config-btn" data-subject="${subjectName}">Configurar</button>
          <button type="button" class="btn-secondary deck-rename-btn" data-subject="${subjectName}">Renombrar</button>
        </div>
      `;
      list.appendChild(row);
    }

    panel.appendChild(list);

    // Exam calendar — always render (shows empty state if no dates configured)
    content.appendChild(await renderExamCalendar(calendarData?.exams || []));

    content.appendChild(panel);

    list.addEventListener('click', async (e) => {
      if (e.target.classList.contains('deck-study-btn')) {
        const studyTabBtn = document.querySelector('[data-tab="study"]');
        studyTabBtn.dataset.subjectFromDashboard = e.target.dataset.subject || '';
        studyTabBtn.click();
      }
      if (e.target.classList.contains('deck-config-btn')) {
        openCurriculumModal(e.target.dataset.subject);
      }
      if (e.target.classList.contains('deck-rename-btn')) {
        const oldSubject = e.target.dataset.subject;
        const newSubject = window.prompt(`Renombrar "${oldSubject}" a:`, oldSubject);
        if (newSubject === null || newSubject.trim() === '' || newSubject.trim() === oldSubject) return;
        try {
          const result = await postJson('/cards/rename-subject', { old_subject: oldSubject, new_subject: newSubject.trim() });
          const n = result.updated ?? 0;
          if (n > 0) loadDashboard();
          else alert('No se encontraron tarjetas para renombrar.');
        } catch (err) {
          alert(`Error: ${err.message}`);
        }
      }
    });

    // Load agenda below subjects
    loadDashboardAgenda().catch(() => {});

  } catch (err) {
    loading.classList.add('hidden');
    content.innerHTML = `<p style="color:var(--fail-fg);padding:16px">Error al cargar: ${err.message}</p>`;
  }
}

// --- Dashboard agenda ---

async function loadDashboardAgenda() {
  const container = document.querySelector('#dashboard-agenda');
  if (!container) return;

  try {
    const data = await getJson('/scheduler/agenda');
    if (!data) return;
    const s = data.summary;
    const buckets = data.buckets ?? {};

    // Only render if there's something to show
    const totalBucketCards = Object.values(buckets).reduce((n, arr) => n + arr.length, 0);
    if (totalBucketCards === 0) return;

    const panel = document.createElement('div');
    panel.className = 'card';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0">Agenda</h3>
        <div class="agenda-pills" style="margin:0">
          ${s.overdue      ? `<span class="agenda-pill overdue">${s.overdue} vencida${s.overdue !== 1 ? 's' : ''}</span>` : ''}
          ${s.due_today    ? `<span class="agenda-pill today">${s.due_today} hoy</span>` : ''}
          ${s.due_tomorrow ? `<span class="agenda-pill soon">${s.due_tomorrow} mañana</span>` : ''}
          <span class="agenda-pill neutral">${s.total_cards} total</span>
        </div>
      </div>
      <div id="dashboard-agenda-buckets"></div>
    `;
    container.innerHTML = '';
    container.appendChild(panel);

    const bucketsEl = container.querySelector('#dashboard-agenda-buckets');
    for (const [key, label] of Object.entries(BUCKET_LABELS)) {
      const cards = buckets[key] ?? [];
      if (!cards.length) continue;

      const section = document.createElement('div');
      section.className = 'agenda-bucket';
      section.innerHTML = `<h4 class="agenda-bucket-title ${key}">${label} <span class="agenda-bucket-count">${cards.length}</span></h4>`;

      for (const card of cards) {
        const due = new Date(card.next_review_at);
        const dueStr = formatDue(due);
        const cardEl = document.createElement('div');
        cardEl.className = 'agenda-card';
        cardEl.innerHTML = `
          <div class="agenda-card-header">
            ${card.subject ? `<span class="agenda-subject-badge">${escHtml(card.subject)}</span>` : ''}
            <span class="agenda-due ${key}">${dueStr}</span>
            <span class="agenda-interval">${card.review_count} revis. · ${card.pass_count} ok</span>
          </div>
          <p class="agenda-card-prompt">${escHtml(truncate(card.prompt_text, 100))}</p>
        `;
        section.appendChild(cardEl);
      }
      bucketsEl.appendChild(section);
    }
  } catch (_) {
    // Agenda is non-critical, fail silently
  }
}

// --- Progress tab ---

async function loadProgress() {
  const loading = document.querySelector('#progress-loading');
  const content = document.querySelector('#progress-content');
  loading.classList.remove('hidden');
  content.classList.add('hidden');

  try {
    const [actData, overview, timingData] = await Promise.all([
      getJson('/stats/activity?days=3650'),
      getJson('/stats/overview').catch(() => ({ subjects: [] })),
      getJson('/stats/timing?weeks=4').catch(() => null)
    ]);

    loading.classList.add('hidden');
    content.classList.remove('hidden');

    // Streak + summary pills
    const pills = document.querySelector('#progress-pills');
    pills.innerHTML = '';
    [
      { num: actData.streak_current, label: 'Racha actual', cls: actData.streak_current > 0 ? 'pass' : '', unit: actData.streak_current === 1 ? 'día' : 'días' },
      { num: actData.streak_best,    label: 'Mejor racha',  cls: '', unit: actData.streak_best === 1 ? 'día' : 'días' },
      { num: actData.total_reviews,  label: 'Revisiones',   cls: '' }
    ].forEach(({ num, label, cls, unit }) => {
      const pill = document.createElement('div');
      pill.className = `progress-pill${cls ? ' ' + cls : ''}`;
      pill.innerHTML = `<span class="progress-pill-num">${num}${unit ? `<span style="font-size:1.1rem;font-weight:600"> ${unit}</span>` : ''}</span><span class="progress-pill-label">${label}</span>`;
      pills.appendChild(pill);
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
      heatmapTitle.textContent = `Historial ${year}`;

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
        const pctColor = pct >= 70 ? 'var(--c-ok)' : pct >= 40 ? 'var(--c-warn)' : 'var(--fail-fg)';
        const row = document.createElement('div');
        row.className = 'progress-subject-row';
        row.innerHTML = `
          <span class="progress-subject-name">${s.subject}</span>
          <div class="progress-subject-bar-track">
            <div class="dimension-bar-fill${pct < 40 ? ' weak' : pct < 70 ? ' mid' : ''}" style="width:${pct}%"></div>
          </div>
          <span class="progress-subject-pct" style="color:${pctColor}">${pct}%</span>
          <span class="progress-subject-count">${s.total_questions}q</span>
        `;
        subjEl.appendChild(row);
      }
    } else {
      subjEl.innerHTML = '<p style="color:var(--c-neutral);font-size:var(--fs-sm)">Sin actividad por materia todavía.</p>';
    }
    // Timing stats
    renderTimingStats(timingData);

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
      if (advisorSelect.value) {
        // Show chat immediately on subject selection — don't wait for analysis
        const chat = document.querySelector('#advisor-chat');
        if (chat) {
          chat.classList.remove('hidden');
          resetAdvisorChat(advisorSelect.value);
        }
        loadAdvisorAnalysis(advisorSelect.value);
      } else {
        const chat = document.querySelector('#advisor-chat');
        if (chat) chat.classList.add('hidden');
        document.querySelector('#advisor-content').innerHTML = '';
        resetAdvisorChat(null);
      }
    });
  } catch (err) {
    loading.classList.add('hidden');
    document.querySelector('#progress-content').innerHTML =
      `<p style="color:var(--fail-fg);padding:16px">Error al cargar progreso: ${err.message}</p>`;
    document.querySelector('#progress-content').classList.remove('hidden');
  }
}

function fmtMs(ms) {
  if (!ms) return '—';
  return ms >= 60000 ? (ms / 60000).toFixed(1) + 'm' : Math.round(ms / 1000) + 's';
}

function renderTimingStats(data) {
  const subjectsEl   = document.querySelector('#progress-timing-subjects');
  const slowCardsEl  = document.querySelector('#progress-timing-slowcards');
  if (!subjectsEl || !slowCardsEl) return;

  if (!data || (!data.by_subject?.length && !data.by_card?.length)) {
    subjectsEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">Aún no hay datos de tiempo de respuesta.</p>';
    slowCardsEl.innerHTML = '';
    return;
  }

  // Weekly trend per subject
  if (data.by_subject?.length) {
    subjectsEl.innerHTML = '<p style="font-size:0.82rem;font-weight:600;color:var(--text-muted);margin-bottom:8px">Promedio semanal por materia</p>';
    for (const { subject, weeks } of data.by_subject) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:8px;font-size:0.85rem';
      const trend = weeks.map(w => {
        const reviewPill = w.avg_review_ms ? ` <span class="time-pill time-pill--review">${fmtMs(w.avg_review_ms)}</span>` : '';
        return `<span style="margin-right:6px;color:var(--text-muted)">${w.week_start?.slice(5)} <span class="time-pill time-pill--active">${fmtMs(w.avg_ms)}</span>${reviewPill}</span>`;
      }).join('→ ');
      row.innerHTML = `<span style="font-weight:600">${escHtml(subject)}</span>: ${trend || '—'}`;
      subjectsEl.appendChild(row);
    }
  } else {
    subjectsEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">Sin datos de tendencia semanal aún.</p>';
  }

  // Top slowest cards
  if (data.by_card?.length) {
    slowCardsEl.innerHTML = '<p style="font-size:0.82rem;font-weight:600;color:var(--text-muted);margin:0 0 8px">Tarjetas más lentas</p>';
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:4px';
    data.by_card.slice(0, 10).forEach(c => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:0.82rem';
      const preview = (c.prompt_text || '').slice(0, 60) + ((c.prompt_text || '').length > 60 ? '…' : '');
      item.innerHTML = `
        <span class="time-pill time-pill--active" style="white-space:nowrap">${fmtMs(c.avg_ms)}</span>
        ${c.avg_review_ms ? `<span class="time-pill time-pill--review" style="white-space:nowrap">${fmtMs(c.avg_review_ms)}</span>` : ''}
        <span style="color:var(--text-muted);font-size:0.75rem;white-space:nowrap">${escHtml(c.subject || '')}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(preview)}</span>
      `;
      list.appendChild(item);
    });
    slowCardsEl.appendChild(list);
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
    textarea.setRangeText('    ', start, end, 'end');
  });
}

attachMathTabInsertion(_evalAnswerTextarea, () => (_editorModeSelect?.value || '') === 'math');
MathPreview.attach(_evalAnswerTextarea, () => (_editorModeSelect?.value || '') === 'math');

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
  MathPreview.refresh(_evalAnswerTextarea);
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

  // 3. Unbalanced parentheses (skip chars inside string literals)
  let depth = 0, lastOpen = -1, inStr = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (let ci = 0; ci < ln.length; ci++) {
      const ch = ln[ci];
      if (ch === "'" && !inStr) { inStr = true; continue; }
      if (ch === "'" && inStr)  { inStr = false; continue; }
      if (inStr) continue;
      if (ch === '(') { depth++; lastOpen = i + 1; }
      else if (ch === ')') { depth--; }
    }
  }
  if (depth > 0) {
    errors.push({ line: lastOpen, message: `ORA-00907: falta el paréntesis derecho`, hint: `Revisá que cada ( tenga su ) correspondiente` });
  } else if (depth < 0) {
    errors.push({ line: lines.length, message: `ORA-00907: paréntesis de cierre sin apertura`, hint: `Hay un ) de más` });
  }

  // Block structure (IF/END IF, LOOP/END LOOP, CASE/END CASE, BEGIN/END) is
  // checked by the backend structural parser — not duplicated here to avoid
  // false positives from the old regex-counting approach.

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
  expected_answer_text: 1,
};

const errorMessages = {
  prompt_text: 'La consigna es obligatoria (mínimo 10 caracteres).',
  user_answer_text: 'La respuesta del usuario es obligatoria (mínimo 5 caracteres).',
  expected_answer_text: 'La respuesta esperada es obligatoria (mínimo 1 carácter).',
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
  if (normalized === 'AGAIN') return 'Again — Sin respuesta útil';
  if (normalized === 'HARD')  return 'Hard — Incompleto';
  if (normalized === 'GOOD')  return 'Good — Correcto';
  if (normalized === 'EASY')  return 'Easy — Dominio total';
  // Legacy compat
  if (normalized === 'REVIEW') {
    return 'requiere validación docente';
  }

  return normalized;
}

function isNegativeGrade(grade) {
  const normalized = normalizeSuggestedGrade(grade);
  return normalized === 'AGAIN' || normalized === 'HARD' || normalized === 'FAIL' || normalized === 'REVIEW';
}

function getPrimaryGapLabel(result = {}) {
  const concepts = Array.isArray(result.missing_concepts) ? result.missing_concepts : [];
  const firstConcept = concepts.find((concept) => String(concept || '').trim().length > 0);
  if (firstConcept) return firstConcept;

  const weakestDimension = Object.entries(result.dimensions || {})
    .sort((a, b) => Number(a[1]) - Number(b[1]))[0];
  if (weakestDimension) {
    const [dimension] = weakestDimension;
    return DIM_LABELS[dimension] || dimension;
  }

  return '';
}

function buildJustificationHtml(result = {}) {
  const grade = normalizeSuggestedGrade(result.suggested_grade);
  const justificationText = String(result.justification_short || result.justification || '').trim();
  const safeJustification = escHtml(justificationText || 'Sin detalle disponible.');
  if (!isNegativeGrade(grade)) {
    return `<span class="justification-detail">${safeJustification}</span>`;
  }

  const primaryGap = getPrimaryGapLabel(result);
  const missingPrefix = primaryGap
    ? `Faltó primero: ${escHtml(primaryGap)}.`
    : 'Faltó primero identificar el punto clave que faltaba en la respuesta.';

  return `<span class="justification-priority-gap">${missingPrefix}</span><span class="justification-detail">${safeJustification}</span>`;
}

function renderJustification(targetEl, result = {}) {
  if (!targetEl) return;
  const grade = normalizeSuggestedGrade(result.suggested_grade);
  targetEl.innerHTML = buildJustificationHtml(result);
  targetEl.classList.toggle('justification-negative', isNegativeGrade(grade));
}

function enqueueManualCase(result) {
  if (!result?.evaluation_id) {
    return { position: null, size: uiState.manualQueue.length };
  }

  const priorityByGrade = {
    AGAIN: 0, HARD: 1, GOOD: 2, EASY: 3,
    // legacy compat
    FAIL: 0, REVIEW: 1, PASS: 2,
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
  renderJustification(document.querySelector('#justification-short'), result);

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
    missingEl.innerHTML = `<strong>Conceptos ausentes:</strong> ${concepts.map((c) => `<span class="concept-tag">${escHtml(c)}</span>`).join(' ')}`;
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
  if (grade === 'AGAIN' || grade === 'FAIL') {
    socraticTrigger.textContent = 'Entender el error';
    socraticTrigger.dataset.label = 'Entender el error';
    socraticTrigger.classList.remove('hidden');
  } else if (grade === 'HARD' || grade === 'REVIEW') {
    socraticTrigger.textContent = 'Profundizar concepto';
    socraticTrigger.dataset.label = 'Profundizar concepto';
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

const MATH_LINE_RE = /[=²³⁰¹⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉αβγδεζηθλμνξπρστφψωΔΩ∑∫∂∞±√∝∈∉∩∪⊂⊃≤≥≠≈]|[a-zA-Z][₀₁₂₃]|[a-zA-Z]\d*[²³]|\b(cos|sin|tan|log|ln|lim|sup|inf|max|min|det|div|rot|grad)\b/;

function formatPromptForDisplay(text) {
  const normalized = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/:\s+([•●▪◦])/g, ':\n$1')
    .replace(/\s+([•●▪◦])\s+/g, '\n$1 ')
    .trim();

  // Detect if text contains math — if so, wrap equation-heavy lines visually
  const lines = normalized.split('\n');
  const hasMath = lines.some(l => MATH_LINE_RE.test(l));
  if (!hasMath) return escapePreserve(normalized);

  return lines.map(line => {
    if (!line.trim()) return '<br>';
    // Lines with = or strong math content get a styled block
    if (/=/.test(line) && MATH_LINE_RE.test(line)) {
      return `<span class="prompt-math-line">${escHtml(line)}</span>`;
    }
    return escHtml(line) + '<br>';
  }).join('');
}

function renderStudyPrompt(promptEl, promptText) {
  if (!promptEl) return;
  promptEl.innerHTML = formatPromptForDisplay(promptText);
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
    const error = new Error(reason);
    if (Array.isArray(data.details)) {
      error.details = data.details;
    }
    throw error;
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

function formatValidationIssues(error) {
  if (!Array.isArray(error?.details) || error.details.length === 0) return '';
  return error.details
    .map((detail) => {
      const field = detail?.field ? `${detail.field}: ` : '';
      return `${field}${detail?.issue || 'Campo inválido.'}`;
    })
    .join(' | ');
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

    setFeedback('Evaluación lista. Ahora firma una decisión final.');
  } catch (error) {
    resultLoading.classList.add('hidden');
    resultContent.classList.add('hidden');
    const validationIssues = formatValidationIssues(error);
    const message = validationIssues ? `${error.message} (${validationIssues})` : error.message;
    setFeedback(`No se pudo evaluar: ${message}`, 'error');
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
      row.innerHTML = `${badge} ${sourceTag} <span style="color:#333">${escHtml(obs.text)}</span>`;
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
    const g = normalizeSuggestedGrade(uiState.lastResult?.suggested_grade);
    return (g === 'FAIL' || g === 'AGAIN' || g === 'HARD') ? 'fail' : 'review';
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
        feedbackBlock.innerHTML = `<p><strong>Lo que faltó:</strong> ${escHtml(error_summary)}</p><p><strong>Concepto correcto:</strong> ${escHtml(correct_concept)}</p>`;
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
        renderJustification(document.querySelector('#justification-short'), {
          ...uiState.lastResult,
          ...reeval,
          justification_short: reeval.justification || reeval.justification_short || uiState.lastResult?.justification_short,
        });
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

  // REVIEW is legacy; new 4-grade system has no REVIEW state
  if (action === 'accept' && normalizedSuggestion === 'REVIEW') {
    setFeedback('Caso en revisión: usá "Corregir a" para asignar un grado específico.', 'error');
    return;
  }

  const finalGradeByAction = {
    accept: suggestion,
    'correct-again': 'AGAIN',
    'correct-hard':  'HARD',
    'correct-good':  'GOOD',
    'correct-easy':  'EASY',
    // legacy compat
    'correct-pass':  'GOOD',
    'correct-fail':  'AGAIN',
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
  selectedSubject:  null,   // null | specific subject filter
  plan:             null,   // response from server
  fullCards:        [],     // full cards from server
  fullMicroCards:   []      // full micro_cards from server
};

const STUDY_PERSIST_KEY = 'study.activeSession.v1';

function persistStudySession() {
  try {
    if (!studyState.queue?.length || !studyState.sessionStartTime) {
      localStorage.removeItem(STUDY_PERSIST_KEY);
      return;
    }
    localStorage.setItem(STUDY_PERSIST_KEY, JSON.stringify({
      queue: studyState.queue,
      index: studyState.index,
      results: studyState.results,
      sessionId: studyState.sessionId,
      sessionStartTime: studyState.sessionStartTime,
      sessionLimitMs: studyState.sessionLimitMs ?? null,
      sessionEnergyLevel: studyState.sessionEnergyLevel ?? null,
      selectedTime: briefingState.selectedTime,
      selectedEnergy: briefingState.selectedEnergy,
      selectedSubject: briefingState.selectedSubject
    }));
  } catch (_) {}
}

function clearPersistedStudySession() {
  try { localStorage.removeItem(STUDY_PERSIST_KEY); } catch (_) {}
}

function restorePersistedStudySession() {
  try {
    const raw = localStorage.getItem(STUDY_PERSIST_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved?.queue?.length || !saved?.sessionStartTime) {
      clearPersistedStudySession();
      return false;
    }

    // Planned sessions expire at their configured limit; ad-hoc sessions expire after 8 hours.
    const limitMs   = saved.sessionLimitMs ? Number(saved.sessionLimitMs) : 8 * 60 * 60 * 1000;
    const expiresAt = Number(saved.sessionStartTime) + limitMs;
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      clearPersistedStudySession();
      return false;
    }

    briefingState.selectedTime = Number(saved.selectedTime) || null;
    briefingState.selectedEnergy = saved.selectedEnergy || null;
    applyStudySubjectFilter(saved.selectedSubject || null);

    studyState.queue = saved.queue;
    studyState.index = Math.max(0, Math.min(saved.index ?? 0, saved.queue.length - 1));
    studyState.results = Array.isArray(saved.results) ? saved.results : [];
    studyState.sessionId = saved.sessionId ?? null;
    studyState.sessionStartTime   = Number(saved.sessionStartTime);
    studyState.sessionLimitMs     = saved.sessionLimitMs ? Number(saved.sessionLimitMs) : null;
    studyState.sessionEnergyLevel = saved.sessionEnergyLevel || null;

    document.querySelector('#study-briefing').classList.add('hidden');
    document.querySelector('#study-overview').classList.add('hidden');
    document.querySelector('#study-complete').classList.add('hidden');
    document.querySelector('#study-session').classList.remove('hidden');
    showStudyCard();
    return true;
  } catch (_) {
    clearPersistedStudySession();
    return false;
  }
}

function normalizeStudySubjectFilter(subject) {
  const normalized = typeof subject === 'string' ? subject.trim() : '';
  if (!normalized || normalized === '(sin materia)') return null;
  return normalized;
}

function applyStudySubjectFilter(subject) {
  briefingState.selectedSubject = normalizeStudySubjectFilter(subject);
  const labelEl = document.querySelector('#study-subject-filter-label');
  if (!labelEl) return;
  if (briefingState.selectedSubject) {
    labelEl.textContent = `Sesión enfocada en: ${briefingState.selectedSubject}`;
    labelEl.classList.remove('hidden');
  } else {
    labelEl.textContent = '';
    labelEl.classList.add('hidden');
  }
}

function initStudyTab() {
  // Show briefing first, hide overview
  document.querySelector('#study-briefing').classList.remove('hidden');
  document.querySelector('#study-overview').classList.add('hidden');

  ensureAddCardFormHandlers();
  document.querySelector('#study-overview-back-btn').addEventListener('click', () => {
    document.querySelector('#study-overview').classList.add('hidden');
    document.querySelector('#study-briefing').classList.remove('hidden');
  });
  document.querySelector('#study-start-btn').addEventListener('click', startStudySession);
  document.querySelector('#study-exit-btn').addEventListener('click', exitStudySession);
  document.querySelector('#study-edit-prompt-btn').addEventListener('click', toggleStudyPromptEdit);
  document.querySelector('#study-clarify-prompt-btn').addEventListener('click', clarifyStudyPrompt);
  document.querySelector('#study-delete-btn').addEventListener('click', deleteCurrentStudyCardFromFront);

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
  MathPreview.attach(
    document.querySelector('#study-answer-input'),
    () => studyState.currentInputMode === 'math'
  );
  bindStudyKeyboardShortcuts();

  document.querySelector('#study-again-btn').addEventListener('click', () => {
    clearPersistedStudySession();
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
  restorePersistedStudySession();
}

function bindStudyKeyboardShortcuts() {
  // Mark the input so re-init calls don't double-bind (actual listener is global below).
  const answerInput = document.querySelector('#study-answer-input');
  if (answerInput) answerInput.dataset.boundStudyShortcuts = 'true';

  if (!document.body.dataset.boundStudyAcceptShortcut) {
    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;

      const sessionVisible = !document.querySelector('#study-session')?.classList.contains('hidden');
      if (!sessionVisible) return;

      if (event.key === 'Enter') {
        // Stage 2: result is visible → accept suggestion.
        const resultVisible = document.querySelector('#study-result-block')?.offsetParent !== null;
        if (resultVisible) {
          const acceptBtn = document.querySelector('#study-decision-block [data-study-action="accept"]');
          if (acceptBtn && !acceptBtn.disabled && acceptBtn.offsetParent !== null) {
            event.preventDefault();
            acceptBtn.click();
            return;
          }
        }
        // Stage 1: result not yet visible → evaluate.
        const evalBtn = document.querySelector('#study-eval-btn');
        if (!evalBtn || evalBtn.disabled || evalBtn.offsetParent === null) return;
        event.preventDefault();
        evalBtn.click();
        return;
      }

      // Ctrl+/ kept as an alias for accepting the suggestion.
      if (event.code === 'Slash') {
        const resultVisible = document.querySelector('#study-result-block')?.offsetParent !== null;
        if (!resultVisible) return;
        const acceptBtn = document.querySelector('#study-decision-block [data-study-action="accept"]');
        if (!acceptBtn || acceptBtn.disabled || acceptBtn.offsetParent === null) return;
        event.preventDefault();
        acceptBtn.click();
      }
    });
    document.body.dataset.boundStudyAcceptShortcut = 'true';
  }
}

function ensureAddCardFormHandlers() {
  const saveBtn = document.querySelector('#card-save-btn');
  const cancelBtn = document.querySelector('#card-cancel-btn');
  if (cancelBtn && !cancelBtn.dataset.boundCancel) {
    cancelBtn.addEventListener('click', () => {
      document.querySelector('#study-add-form').classList.add('hidden');
    });
    cancelBtn.dataset.boundCancel = 'true';
  }
  if (saveBtn && !saveBtn.dataset.boundSave) {
    saveBtn.addEventListener('click', saveNewCard);
    saveBtn.dataset.boundSave = 'true';
  }
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
      energy_level:      briefingState.selectedEnergy,
      ...(briefingState.selectedSubject ? { subject: briefingState.selectedSubject } : {})
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
  studyState.pendingMicroGeneration = 0;
  studyState.sessionId             = null;
  studyState.sessionStartTime      = Date.now();
  studyState.sessionLimitMs        = briefingState.selectedTime * 60 * 1000;
  studyState.sessionEnergyLevel    = briefingState.selectedEnergy;

  // Record session start for calibration
  postJson('/study/sessions', {
    planned_minutes:    briefingState.selectedTime,
    planned_card_count: queue.length,
    energy_level:       briefingState.selectedEnergy
  }).then(d => { studyState.sessionId = d?.session_id ?? null; }).catch(() => {});

  document.querySelector('#study-briefing').classList.add('hidden');
  document.querySelector('#study-overview').classList.add('hidden');
  document.querySelector('#study-complete').classList.add('hidden');
  document.querySelector('#study-session').classList.remove('hidden');

  persistStudySession();
  showStudyCard();
}

function exitStudySession() {
  if (studyState.timerInterval) {
    clearInterval(studyState.timerInterval);
    studyState.timerInterval = null;
  }
  document.querySelector('#study-session').classList.add('hidden');
  document.querySelector('#study-overview').classList.remove('hidden');
  persistStudySession();
}

async function loadStudyOverview() {
  const summary = document.querySelector('#study-queue-summary');
  const actions = document.querySelector('#study-overview-actions');
  summary.innerHTML = '<span style="color:#888">Cargando cola...</span>';
  actions.classList.add('hidden');

  try {
    const subjectQuery = briefingState.selectedSubject
      ? `?subject=${encodeURIComponent(briefingState.selectedSubject)}`
      : '';
    const data = await getJson(`/scheduler/session${subjectQuery}`);
    const microCount = data.micro_cards?.length ?? 0;
    const cardCount  = data.cards?.length ?? 0;
    const total      = microCount + cardCount;

    const subjectTag = briefingState.selectedSubject
      ? ` <span style="font-size:0.82rem;color:var(--text-muted);font-weight:400">· ${escHtml(briefingState.selectedSubject)}</span>`
      : '';
    if (total === 0) {
      summary.innerHTML = `<span style="color:#4a7;font-weight:600">Sin tarjetas para hoy. ¡Al día!</span>${subjectTag}`;
    } else {
      summary.innerHTML = `
        <span class="study-queue-count">${total}</span> tarjeta${total !== 1 ? 's' : ''} para hoy${subjectTag}
        ${microCount > 0 ? `<span class="study-queue-detail">(${microCount} micro-concepto${microCount !== 1 ? 's' : ''})</span>` : ''}
      `;
    }
    actions.classList.remove('hidden');
  } catch (err) {
    summary.innerHTML = `<span style="color:#c00">Error al cargar la cola: ${err.message}</span>`;
  }
}

async function saveNewCard() {
  if (saveNewCard.isSaving) return;
  const subject  = document.querySelector('#card-subject').value.trim();
  const prompt   = document.querySelector('#card-prompt').value.trim();
  const expected = document.querySelector('#card-expected').value.trim();
  const feedback = document.querySelector('#card-save-feedback');
  const saveBtn = document.querySelector('#card-save-btn');

  if (!prompt || !expected) {
    feedback.textContent = 'La pregunta y la respuesta esperada son obligatorias.';
    feedback.style.color = '#c00';
    return;
  }

  try {
    saveNewCard.isSaving = true;
    if (saveBtn) saveBtn.disabled = true;
    feedback.textContent = 'Guardando tarjeta...';
    feedback.style.color = '#666';
    const createdCard = await postJson('/scheduler/cards', { subject, prompt_text: prompt, expected_answer_text: expected });
    const nextReview = createdCard?.next_review_at ? new Date(createdCard.next_review_at) : null;
    const now = new Date();
    const releaseDay = nextReview ? nextReview.toDateString() : now.toDateString();
    feedback.textContent = releaseDay !== now.toDateString()
      ? `Tarjeta guardada. Se libera el ${nextReview.toLocaleDateString('es-AR')}.`
      : 'Tarjeta guardada.';
    feedback.style.color = '#4a7';
    document.querySelector('#card-subject').value = subject; // keep subject for next card
    document.querySelector('#card-prompt').value = '';
    document.querySelector('#card-expected').value = '';
    document.querySelector('#card-prompt').focus();
    loadBrowserCards().catch(() => {});
    loadStudyOverview().catch(() => {});
    setTimeout(() => { feedback.textContent = ''; }, 2500);
  } catch (err) {
    feedback.textContent = `Error: ${err.message}`;
    feedback.style.color = '#c00';
  } finally {
    saveNewCard.isSaving = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}
saveNewCard.isSaving = false;

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
  reviewStartTime: 0,
  reviewTimeMs: 0,
  pendingMicroGeneration: 0,
  timerInterval: null,
  sessionId: null,
  sessionStartTime: 0,
  sessionLimitMs: null,
  sessionEnergyLevel: null
};

function renderStudyBackgroundStatus() {
  const statusEl = document.querySelector('#study-background-status');
  if (!statusEl) return;
  const pending = Number(studyState.pendingMicroGeneration) || 0;
  if (pending <= 0) {
    statusEl.textContent = '';
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.textContent = pending === 1
    ? 'Espere, generando microconsignas…'
    : `Espere, generando microconsignas… (${pending})`;
  statusEl.classList.remove('hidden');
}

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
  const subjectQuery = briefingState.selectedSubject
    ? `?subject=${encodeURIComponent(briefingState.selectedSubject)}`
    : '';
  const data = await getJson(`/scheduler/session${subjectQuery}`);
  const micros = (data.micro_cards ?? []).map((m) => ({ type: 'micro', data: m }));
  const cards  = (data.cards ?? []).map((c) => ({ type: 'card', data: c }));

  studyState.queue              = [...micros, ...cards];
  studyState.index              = 0;
  studyState.results            = [];
  studyState.pendingMicroGeneration = 0;
  studyState.currentEvalResult  = null;
  studyState.currentEvalContext = null;
  studyState.currentDecision    = null;
  studyState.sessionStartTime   = Date.now();
  studyState.sessionLimitMs     = null; // ad-hoc: no time limit (8 h expiry)
  studyState.sessionEnergyLevel = briefingState.selectedEnergy || null;
  renderStudyBackgroundStatus();

  if (studyState.queue.length === 0) {
    loadStudyOverview();
    return;
  }

  document.querySelector('#study-overview').classList.add('hidden');
  document.querySelector('#study-add-form').classList.add('hidden');
  document.querySelector('#study-complete').classList.add('hidden');
  document.querySelector('#study-session').classList.remove('hidden');

  persistStudySession();
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
  const subjectEl = document.querySelector('#study-card-subject');
  const promptEl = document.querySelector('#study-card-prompt');
  const parentContextEl = document.querySelector('#study-card-parent-context');
  const parentPromptEl  = document.querySelector('#study-card-parent-prompt');
  const subject = item.type === 'micro' ? item.data.parent_subject : item.data.subject;
  const subjectLabel = subject || '(sin materia)';

  subjectEl.textContent = `Materia: ${subjectLabel}`;

  if (item.type === 'micro') {
    badge.textContent = 'Micro-concepto';
    badge.classList.remove('hidden');
    renderStudyPrompt(promptEl, getStudyPromptText(item));
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
    renderStudyPrompt(promptEl, getStudyPromptText(item));
  }
  setStudyPromptFeedback('');

  const editPromptBtn = document.querySelector('#study-edit-prompt-btn');
  const backBtn = document.querySelector('#study-back-btn');
  const clarifyPromptBtn = document.querySelector('#study-clarify-prompt-btn');
  const deleteBtn = document.querySelector('#study-delete-btn');
  if (editPromptBtn) editPromptBtn.textContent = 'Editar';
  if (backBtn) backBtn.disabled = studyState.index === 0;
  if (clarifyPromptBtn) clarifyPromptBtn.disabled = false;
  if (deleteBtn) deleteBtn.hidden = !['card', 'micro'].includes(item.type);

  // Reset answer + result blocks (refresh SQL layer to clear ghost text)
  const _studyInput = document.querySelector('#study-answer-input');
  MathPreview.clear(_studyInput);
  SqlEditor.refresh();
  document.querySelector('#study-answer-block').classList.remove('hidden');
  document.querySelector('#study-result-block').classList.add('hidden');
  document.querySelector('#study-doubt-section')?.classList.add('hidden');
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
  studyState.reviewStartTime = 0;
  studyState.reviewTimeMs = 0;
  const timerEl = document.querySelector('#study-timer');
  timerEl.textContent = '0s';
  studyState.timerInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - studyState.cardStartTime) / 1000);
    timerEl.textContent = `${elapsed}s`;
  }, 1000);

  // Update subject for dictation (attached once in initStudyTab)
  document.querySelector('#study-dictation-btn').dataset.subject = subject || '';

  // Math Palette + SQL Editor — use saved mode, explicit only (no auto-detect)
  const studyAnswerInput = document.querySelector('#study-answer-input');
  MathPalette.setActiveTextarea(studyAnswerInput);
  const savedMode   = getSubjectMode(subject);
  const isMicro     = item.type === 'micro';
  const studySqlMode = savedMode === 'sql';
  studyState.currentInputMode = savedMode === 'math' ? 'math' : studySqlMode ? 'sql' : '';

  if (savedMode === 'math') {
    MathPalette.show();
    SqlEditor.deactivate();
  } else if (studySqlMode) {
    MathPalette.hide();
    SqlEditor.activate(studyAnswerInput);
  } else {
    MathPalette.updateSubject(subject || '');
    SqlEditor.deactivate();
  }
  MathPreview.refresh(studyAnswerInput);

  // Show SQL compiler panel (optional, never blocks eval button)
  if (studyCompilerPanel) {
    if (studySqlMode) {
      studyCompilerPanel.classList.remove('hidden');
    } else {
      studyCompilerPanel.classList.add('hidden');
    }
  }
  studyEvalBtn.disabled = false; // verification is always optional

  // ── Mode toggle button ────────────────────────────────────────────────────
  const modeToggleBtn = document.querySelector('#study-mode-toggle');
  if (modeToggleBtn) {
    const MODE_CYCLE  = ['', 'sql', 'math'];
    const MODE_LABELS = { '': 'Texto', 'sql': 'SQL/PL', 'math': 'Math' };
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
      MathPreview.refresh(input);
    };
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

async function toggleStudyPromptEdit() {
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

  renderStudyPrompt(promptEl, editedPrompt);
  editBtn.textContent = 'Editar';
  setStudyPromptFeedback('Guardando...', 'info');

  try {
    if (item.type === 'micro') {
      await postJson(`/micro-cards/${item.data.id}/question`, { question: editedPrompt }, 'PATCH');
      item.data.question = editedPrompt;
    } else {
      await postJson('/cards/batch', { action: 'edit', ids: [item.data.id], prompt_text: editedPrompt });
      item.data.prompt_text = editedPrompt;
    }
    setStudyPromptFeedback('Consigna guardada.', 'success');
  } catch (_) {
    setStudyPromptFeedback('Error al guardar (cambio aplicado solo esta sesión).', 'error');
  }
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

  const expectedAnswer = (item.type === 'micro'
    ? item.data.expected_answer
    : item.data.expected_answer_text
  ) || '';

  try {
    const data = await postJson('/prompts/clarify', { prompt_text: promptText });
    const clarifiedPrompt = (data.clarified_prompt || '').trim();
    if (clarifiedPrompt.length < 10) throw new Error('No se pudo generar una versión clara de la consigna.');

    // Guard: reject if the LLM returned the expected answer instead of rephrasing the question
    if (expectedAnswer && clarifiedPrompt.trim().toLowerCase() === expectedAnswer.trim().toLowerCase()) {
      throw new Error('El modelo devolvió la respuesta en lugar de reformular la consigna. Intentá de nuevo.');
    }

    if (item.type === 'micro') item.data.session_question = clarifiedPrompt;
    else item.data.session_prompt_text = clarifiedPrompt;

    promptEl.removeAttribute('contenteditable');
    renderStudyPrompt(promptEl, clarifiedPrompt);
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

  const normalizedPrompt = normalize(prompt_text || '');
  const normalizedExpected = normalize(expected_answer_text || '');
  if (normalizedPrompt.length < minRules.prompt_text) {
    evalBtn.disabled = false;
    evalBtn.textContent = 'Evaluar';
    alert('No se puede evaluar: la consigna de esta tarjeta es demasiado corta o está vacía.');
    return;
  }
  if (answer.length < minRules.user_answer_text) {
    evalBtn.disabled = false;
    evalBtn.textContent = 'Evaluar';
    alert('Tu respuesta debe tener al menos 5 caracteres para poder evaluarse.');
    return;
  }
  if (normalizedExpected.length < minRules.expected_answer_text) {
    evalBtn.disabled = false;
    evalBtn.textContent = 'Evaluar';
    alert('No se puede evaluar esta tarjeta porque no tiene respuesta esperada cargada.');
    return;
  }

  try {
    const evaluationPayload = {
      prompt_text: normalizedPrompt,
      user_answer_text: answer,
      expected_answer_text: normalizedExpected,
      ...(subject && subject.trim() ? { subject: subject.trim() } : {})
    };

    const result = await postJson(EVALUATE_ENDPOINT, evaluationPayload);

    studyState.currentEvalResult = result;
    studyState.currentExpectedAnswer = expected_answer_text;
    studyState.currentEvalContext = {
      prompt_text: normalizedPrompt,
      user_answer_text: answer,
      expected_answer_text: normalizedExpected,
      ...(subject && subject.trim() ? { subject: subject.trim() } : {})
    };
    studyState.currentDecision = null;

    const gradeEl    = document.querySelector('#study-result-grade');
    const justEl     = document.querySelector('#study-result-justification');
    const missingEl  = document.querySelector('#study-result-missing');
    const expectedEl = document.querySelector('#study-result-expected');
    const grade      = normalizeSuggestedGrade(result.suggested_grade);

    gradeEl.textContent = getSuggestedGradeLabel(result.suggested_grade);
    gradeEl.className   = `study-grade-inline ${grade.toLowerCase()}`;
    renderJustification(justEl, result);
    justEl.classList.remove('hidden');

    const timeEl = document.querySelector('#study-result-time');
    if (timeEl) {
      const elapsed = Math.round((studyState.responseTimeMs || 0) / 1000);
      timeEl.innerHTML = `<span class="time-pill time-pill--active">${elapsed}s activo</span>`;
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
    missingEl.textContent = '';
    missingEl.classList.add('hidden');

    const weakTags = weakDimensions.map(([dimension, value]) => {
      const label = DIM_LABELS[dimension] || dimension;
      const pct = Math.round(Number(value) * 100);
      return `<span class="study-dimension-chip weak">${label}: ${pct}%</span>`;
    }).join(' ');
    const missingTags = concepts.map((c) => `<span class="concept-tag">${escHtml(c)}</span>`).join(' ');
    const groupedTags = (weakTags || missingTags)
      ? `<div class="study-answer-compare-block"><strong>Etiquetas:</strong> ${weakTags}${weakTags && missingTags ? ' ' : ''}${missingTags}</div>`
      : '';

    // Always show answer comparison.
    expectedEl.innerHTML = `
      ${groupedTags}
      ${formatAnswerBlock('Tu respuesta', answer)}
      ${formatAnswerBlock('Respuesta esperada', expected_answer_text)}
    `;
    expectedEl.classList.remove('hidden');

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
    document.querySelector('#study-variant-preview')?.classList.add('hidden');
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

    // Start review timer (time spent reading the answer/feedback)
    studyState.reviewStartTime = Date.now();
    studyState.reviewTimeMs = 0;

    // Show doubt section, reset it
    const doubtSection = document.querySelector('#study-doubt-section');
    if (doubtSection) {
      doubtSection.classList.remove('hidden');
      document.querySelector('#study-doubt-form').classList.add('hidden');
      document.querySelector('#study-doubt-answer').classList.add('hidden');
      document.querySelector('#study-doubt-input').value = '';
    }
  } catch (err) {
    evalBtn.disabled = false;
    evalBtn.textContent = 'Evaluar';
    const validationIssues = formatValidationIssues(err);
    const message = validationIssues ? `${err.message}\n${validationIssues}` : err.message;
    alert(`Error al evaluar: ${message}`);
  }
});

function resolveStudyFinalGrade(action, suggestedGrade) {
  const normalizedSuggested = normalizeSuggestedGrade(suggestedGrade);
  if (action === 'correct-again') return 'AGAIN';
  if (action === 'correct-hard')  return 'HARD';
  if (action === 'correct-good')  return 'GOOD';
  if (action === 'correct-easy')  return 'EASY';
  // legacy compat
  if (action === 'correct-pass')  return 'GOOD';
  if (action === 'correct-fail')  return 'AGAIN';
  if (action === 'accept') return normalizedSuggested;
  return null;
}

async function archiveCurrentStudyCard(reason) {
  const currentItem = studyState.queue[studyState.index];
  if (!currentItem || !['card', 'micro'].includes(currentItem.type)) {
    throw new Error('No hay una tarjeta válida para eliminar.');
  }
  if (!reason || reason.length < 5) {
    throw new Error('Indicá un motivo de al menos 5 caracteres para archivar.');
  }

  const path = currentItem.type === 'card'
    ? `/cards/${currentItem.data.id}/archive`
    : `/micro-cards/${currentItem.data.id}/archive`;
  await postJson(path, { reason }, 'PATCH');
}

async function deleteCurrentStudyCardFromFront() {
  const item = studyState.queue[studyState.index];
  if (!item || !['card', 'micro'].includes(item.type)) return;

  const reason = (window.prompt('Motivo para eliminar la tarjeta (mínimo 5 caracteres):', 'Eliminada desde el frente de la tarjeta') || '').trim();
  if (!reason) return;
  if (reason.length < 5) {
    alert('Ingresá un motivo de al menos 5 caracteres.');
    return;
  }

  const deleteBtn = document.querySelector('#study-delete-btn');
  if (deleteBtn) {
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Eliminando...';
  }

  try {
    await archiveCurrentStudyCard(reason);
    studyState.queue.splice(studyState.index, 1);
    if (studyState.index >= studyState.queue.length) {
      studyState.index = Math.max(0, studyState.queue.length - 1);
    }
    persistStudySession();
    showStudyCard();
  } catch (err) {
    alert(`No se pudo eliminar la tarjeta: ${err.message}`);
  } finally {
    if (deleteBtn) {
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Eliminar';
    }
  }
}

const studyDecisionBlock = document.querySelector('#study-decision-block');
if (studyDecisionBlock) {
  studyDecisionBlock.addEventListener('click', async (event) => {
    const action = event.target?.dataset?.studyAction;
    if (!action || !studyState.currentEvalResult || !studyState.currentEvalContext) return;

    const feedbackEl = document.querySelector('#study-decision-feedback');
    const reasonEl = document.querySelector('#study-correction-reason');
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
      const nextBtn = document.querySelector('#study-next-btn');
      if (nextBtn) nextBtn.disabled = false;
      if (!isArchiveAction && action === 'accept') {
        if (feedbackEl) feedbackEl.textContent = 'Firma guardada. Pasando a la siguiente tarjeta...';
        await handleStudyNextCard();
      }
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

  const variantPreview = document.querySelector('#study-variant-preview');
  const variantPreviewQ = document.querySelector('#study-variant-preview-q');
  const variantPreviewA = document.querySelector('#study-variant-preview-a');

  try {
    const resp = await postJson(`/scheduler/cards/${item.data.id}/variant`, {});
    variantBtn.classList.add('hidden');
    variantFb.textContent = 'Variante guardada.';
    variantFb.style.color = 'var(--pass-fg)';
    variantFb.classList.remove('hidden');
    if (resp?.variant) {
      variantPreviewQ.textContent = resp.variant.prompt_text || '';
      variantPreviewA.textContent = resp.variant.expected_answer_text || '';
      variantPreview.classList.remove('hidden');
    }
  } catch (err) {
    variantBtn.disabled = false;
    variantBtn.textContent = '+ Guardar variante';
    variantFb.textContent = `Error: ${err.message}`;
    variantFb.style.color = 'var(--fail-fg)';
    variantFb.classList.remove('hidden');
  }
});

// ── Doubt chat post-response ──────────────────────────────────────────────────
document.querySelector('#study-doubt-toggle').addEventListener('click', () => {
  document.querySelector('#study-doubt-form').classList.toggle('hidden');
});

document.querySelector('#study-doubt-btn').addEventListener('click', async () => {
  const question = (document.querySelector('#study-doubt-input').value || '').trim();
  if (!question) return;

  const item       = studyState.queue[studyState.index];
  const evalResult = studyState.currentEvalResult;
  const btn        = document.querySelector('#study-doubt-btn');
  const answerEl   = document.querySelector('#study-doubt-answer');

  btn.disabled = true;
  btn.textContent = 'Consultando...';
  answerEl.classList.add('hidden');

  const isMicro = item?.type === 'micro';
  const cardPrompt    = isMicro ? item.data.question    : item.data.prompt_text;
  const expectedAns   = isMicro ? item.data.expected_answer : item.data.expected_answer_text;
  const subject       = isMicro ? item.data.parent_subject  : item.data.subject;
  const userAnswer    = (document.querySelector('#study-answer-input').value || '').trim();
  const grade         = evalResult ? String(evalResult.suggested_grade || '').toLowerCase() : '';

  try {
    const data = await postJson('/study/doubt', {
      card_prompt:     cardPrompt   || '',
      expected_answer: expectedAns  || '',
      user_answer:     userAnswer   || '',
      grade,
      question,
      subject: subject || ''
    });
    answerEl.textContent = data?.answer || '(sin respuesta)';
    answerEl.classList.remove('hidden');
  } catch (err) {
    answerEl.textContent = `Error: ${err.message}`;
    answerEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Consultar';
  }
});

document.querySelector('#study-next-btn').addEventListener('click', async () => {
  await handleStudyNextCard();
});

async function handleStudyNextCard() {
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

  // Capture review time (time from answer revealed to Siguiente clicked)
  if (studyState.reviewStartTime) {
    studyState.reviewTimeMs = Date.now() - studyState.reviewStartTime;
  }

  // Update time display to show review pill alongside active pill
  const _timeEl = document.querySelector('#study-result-time');
  if (_timeEl && studyState.reviewTimeMs) {
    const reviewSec = Math.round(studyState.reviewTimeMs / 1000);
    _timeEl.innerHTML += ` <span class="time-pill time-pill--review">${reviewSec}s revisión</span>`;
  }

  const grade  = decision.finalGrade;
  const gaps   = evalResult.missing_concepts ?? [];
  const shouldGenerateMicros = Boolean(grade && item.type === 'card');

  if (shouldGenerateMicros) {
    studyState.pendingMicroGeneration += 1;
    renderStudyBackgroundStatus();
  }

  if (grade && item.type === 'micro') {
    try {
      await postJson('/scheduler/review', {
        micro_card_id: item.data.id,
        grade,
        response_time_ms: studyState.responseTimeMs || undefined,
        review_time_ms:   studyState.reviewTimeMs   || undefined
      });
    } catch (err) {
      console.warn('Review record failed:', err.message);
    }
  }

  studyState.results.push({
    grade: grade || 'uncertain',
    type: item.type,
    concept: item.type === 'micro' ? item.data.concept : null
  });
  persistStudySession();

  if (shouldGenerateMicros) {
    postJson('/scheduler/review', {
      card_id: item.data.id,
      grade,
      concept_gaps: gaps,
      response_time_ms: studyState.responseTimeMs || undefined,
      review_time_ms:   studyState.reviewTimeMs   || undefined,
      user_answer: studyState.currentEvalContext?.user_answer_text || ''
    }).then((reviewResp) => {
      // Insert generated micro-cards *after* the card currently on screen.
      // If we insert at `studyState.index`, we would silently replace the logical
      // "current card" while the UI still shows the previous prompt.
      const newMicros = (reviewResp?.new_micro_cards ?? []).map((m) => ({ type: 'micro', data: m }));
      if (newMicros.length) {
        studyState.queue.splice(studyState.index + 1, 0, ...newMicros);
        persistStudySession();
      }
      loadAgenda();
    }).catch((err) => {
      console.warn('Background review record failed:', err.message);
    }).finally(() => {
      studyState.pendingMicroGeneration = Math.max(0, (studyState.pendingMicroGeneration || 0) - 1);
      renderStudyBackgroundStatus();
    });
  }

  advanceStudyCard();
}

document.querySelector('#study-back-btn')?.addEventListener('click', () => {
  if (studyState.index <= 0) return;
  studyState.index -= 1;
  persistStudySession();
  showStudyCard();
});

function advanceStudyCard() {
  studyState.index++;
  if (studyState.index >= studyState.queue.length) {
    finishStudySession();
  } else {
    persistStudySession();
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

  // Record actual session time for calibration
  if (studyState.sessionId && studyState.sessionStartTime) {
    const actualMinutes = (Date.now() - studyState.sessionStartTime) / 60000;
    postJson(`/study/sessions/${studyState.sessionId}`, {
      actual_minutes:    Math.round(actualMinutes * 100) / 100,
      actual_card_count: results.length
    }, 'PATCH').then(() => {
      const plannedMin = briefingState.selectedTime || 0;
      const actualMin  = Math.round(actualMinutes);
      if (plannedMin > 0) {
        const timingEl = document.createElement('p');
        timingEl.style.cssText = 'font-size:0.85rem;color:var(--text-muted);margin-top:4px';
        timingEl.textContent = `Planificaste ${plannedMin} min · Tardaste ${actualMin} min`;
        document.querySelector('#study-complete-summary').appendChild(timingEl);
      }
    }).catch(() => {});
    studyState.sessionId = null;
  }
  studyState.pendingMicroGeneration = 0;
  renderStudyBackgroundStatus();
  clearPersistedStudySession();

  loadStudyOverview();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: Auth.getToken() ? { 'Authorization': 'Bearer ' + Auth.getToken() } : {}
  });
  Auth.handleRefreshToken(res);
  if (res.status === 401) { if (Auth.isLoggedIn()) Auth.logout(); return null; }
  if (!res.ok) {
    let reason = '';
    try {
      const data = await res.json();
      reason = data?.message || data?.error || '';
    } catch (_e) {
      // noop: fallback below
    }
    throw new Error(reason ? `${reason} (HTTP ${res.status})` : `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Weekly Planner ───────────────────────────────────────────────────────────

const PLANNER_SLOTS = (() => {
  const s = [];
  for (let h = 6; h < 22; h++) {
    s.push(`${String(h).padStart(2,'0')}:00`);
    s.push(`${String(h).padStart(2,'0')}:30`);
  }
  return s; // '06:00' .. '21:30'
})();

const PLANNER_DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const plannerState = {
  weekStart: null,   // Date (Sunday at midnight)
  cells: {},         // key `${dayIndex}_${slot}` → {content, color, isFixed}
  activitySlots: {}, // key `${dayIndex}_${slot}` → {eventsCount, lastEventAt}
  saveTimers: {},    // debounce per cell
  activeCell: null,  // currently focused td
  fillDrag: null,    // { source: { content, color, isFixed }, paintedKeys:Set<string> }
  suppressNextClick: false,
  nowMarkerTimer: null,
};

function plannerWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // rewind to Sunday
  return d;
}

function plannerDateStr(date) {
  // Returns YYYY-MM-DD
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function plannerWeekLabel(sunday) {
  const sat = new Date(sunday);
  sat.setDate(sat.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
  return `${fmt(sunday)} – ${fmt(sat)} ${sunday.getFullYear()}`;
}

function plannerIsFutureSlot(weekStart, dayIndex, slot) {
  if (!weekStart || typeof slot !== 'string') return false;
  const [hourStr, minuteStr] = slot.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return false;

  const slotDate = new Date(weekStart);
  slotDate.setDate(slotDate.getDate() + dayIndex);
  slotDate.setHours(hour, minute, 0, 0);
  return slotDate.getTime() > Date.now();
}

function buildPlannerGrid(weekStart, cells, activitySlots = {}) {
  const wrap = document.querySelector('#planner-grid-wrap');
  wrap.innerHTML = '';

  const table = document.createElement('table');
  table.className = 'planner-table';
  table.id = 'planner-table';

  // Header
  const thead = document.createElement('thead');
  let hrow = '<tr><th class="planner-th-time"></th>';
  for (let d = 0; d < 7; d++) {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + d);
    const isToday = plannerDateStr(date) === plannerDateStr(new Date());
    hrow += `<th class="planner-th-day${isToday ? ' planner-today-col' : ''}">
      <div>${PLANNER_DAYS[d]}</div>
      <div class="planner-date-num">${date.getDate()}/${date.getMonth()+1}</div>
    </th>`;
  }
  hrow += '</tr>';
  thead.innerHTML = hrow;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const slot of PLANNER_SLOTS) {
    const tr = document.createElement('tr');
    const timeTd = document.createElement('td');
    timeTd.className = 'planner-time';
    timeTd.textContent = slot;
    tr.appendChild(timeTd);

    for (let d = 0; d < 7; d++) {
      const key = `${d}_${slot}`;
      const cell = cells[key] || {};
      const td = document.createElement('td');
      td.className = 'planner-cell';
      td.dataset.day = d;
      td.dataset.slot = slot;
      td.dataset.color = cell.color || '';
      td.dataset.fixed = cell.isFixed ? '1' : '';
      if (cell.color) td.style.background = cell.color;
      td.textContent = cell.content || '';
      const slotActivity = activitySlots[key];
      if (slotActivity && !plannerIsFutureSlot(weekStart, d, slot)) {
        td.classList.add('planner-cell-study-active');
        td.dataset.activityCount = String(slotActivity.eventsCount || 0);
        const activityDate = slotActivity.lastEventAt ? new Date(slotActivity.lastEventAt) : null;
        const activityTime = activityDate && !Number.isNaN(activityDate.getTime())
          ? activityDate.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
          : null;
        const mins = slotActivity.studyMinutes || 0;
        td.title = `${slotActivity.eventsCount} repaso${slotActivity.eventsCount !== 1 ? 's' : ''} · ${mins > 0 ? mins + ' min estudiados' : 'tiempo no registrado'}${activityTime ? ` · última: ${activityTime}` : ''}`;
        if (mins > 0) {
          const minsBadge = document.createElement('span');
          minsBadge.className = 'planner-mins-badge';
          minsBadge.textContent = `${mins}m`;
          td.appendChild(minsBadge);
        }
      }
      tbody.appendChild(tr);
      tr.appendChild(td);
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  // Event delegation on the table
  table.addEventListener('click', (e) => {
    if (plannerState.suppressNextClick) {
      plannerState.suppressNextClick = false;
      return;
    }
    const td = e.target.closest('.planner-cell');
    if (!td) return;
    plannerActivateCell(td);
  });
  table.addEventListener('mousedown', plannerOnGridMouseDown);
  table.addEventListener('mouseover', plannerOnGridMouseOver);
}

function plannerCurrentSlotKey(now = new Date()) {
  const day = now.getDay();
  const hour = now.getHours();
  const minute = now.getMinutes();
  if (hour < 6 || hour >= 22) return null;
  const normalizedMinute = minute < 30 ? '00' : '30';
  return `${day}_${String(hour).padStart(2, '0')}:${normalizedMinute}`;
}

function plannerMarkCurrentSlot() {
  document.querySelectorAll('.planner-current-slot').forEach((el) => {
    el.classList.remove('planner-current-slot');
  });
  if (!plannerState.weekStart) return;
  if (plannerDateStr(plannerWeekStart(new Date())) !== plannerDateStr(plannerState.weekStart)) return;
  const key = plannerCurrentSlotKey(new Date());
  if (!key) return;
  const [day, slot] = key.split('_');
  const cell = document.querySelector(`#planner-table td[data-day="${day}"][data-slot="${slot}"]`);
  if (cell) cell.classList.add('planner-current-slot');
}

function plannerCellSnapshot(td) {
  return {
    content: td.textContent.trim(),
    color: td.dataset.color || '',
    isFixed: td.dataset.fixed === '1'
  };
}

function plannerCellKey(td) {
  return `${td.dataset.day}_${td.dataset.slot}`;
}

function plannerPaintCell(td, source) {
  td.textContent = source.content;
  td.dataset.color = source.color;
  td.style.background = source.color || '';
  td.dataset.fixed = source.isFixed ? '1' : '';
  plannerSaveCell(td);
}

function plannerOnGridMouseDown(e) {
  const td = e.target.closest('.planner-cell');
  if (!td || !e.altKey) return;
  e.preventDefault();
  plannerState.suppressNextClick = true;
  plannerState.fillDrag = {
    source: plannerCellSnapshot(td),
    paintedKeys: new Set([plannerCellKey(td)])
  };
}

function plannerOnGridMouseOver(e) {
  if (!plannerState.fillDrag) return;
  const td = e.target.closest('.planner-cell');
  if (!td) return;
  const key = plannerCellKey(td);
  if (plannerState.fillDrag.paintedKeys.has(key)) return;
  plannerState.fillDrag.paintedKeys.add(key);
  plannerPaintCell(td, plannerState.fillDrag.source);
}

function plannerActivateCell(td) {
  // Deactivate previous
  if (plannerState.activeCell && plannerState.activeCell !== td) {
    plannerDeactivateCell(plannerState.activeCell);
  }
  plannerState.activeCell = td;
  td.classList.add('planner-cell-active');
  td.contentEditable = 'true';
  td.focus();
  // Move cursor to end
  const range = document.createRange();
  range.selectNodeContents(td);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  // Show color bar highlight for active color
  updateColorBarSelection(td.dataset.color);
  const fixedToggle = document.querySelector('#planner-fixed-toggle');
  if (fixedToggle) fixedToggle.checked = td.dataset.fixed === '1';

  td.addEventListener('blur', plannerOnCellBlur, { once: true });
  td.addEventListener('keydown', plannerOnCellKeydown);
}

function plannerDeactivateCell(td) {
  td.contentEditable = 'false';
  td.classList.remove('planner-cell-active');
  td.removeEventListener('keydown', plannerOnCellKeydown);
}

function plannerOnCellBlur(e) {
  const td = e.target;
  plannerDeactivateCell(td);
  plannerSaveCell(td);
  plannerState.activeCell = null;
}

function plannerOnCellKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.target.blur();
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.target.blur();
    // Move to next row same column
    const day  = parseInt(e.target.dataset.day);
    const slot = e.target.dataset.slot;
    const idx  = PLANNER_SLOTS.indexOf(slot);
    if (idx < PLANNER_SLOTS.length - 1) {
      const nextSlot = PLANNER_SLOTS[idx + 1];
      const next = document.querySelector(`#planner-table td[data-day="${day}"][data-slot="${nextSlot}"]`);
      if (next) plannerActivateCell(next);
    }
  } else if (e.key === 'Tab') {
    e.preventDefault();
    e.target.blur();
    // Move to next day same slot
    const day  = parseInt(e.target.dataset.day);
    const slot = e.target.dataset.slot;
    const nextDay = e.shiftKey ? day - 1 : day + 1;
    if (nextDay >= 0 && nextDay <= 6) {
      const next = document.querySelector(`#planner-table td[data-day="${nextDay}"][data-slot="${slot}"]`);
      if (next) plannerActivateCell(next);
    }
  }
}

function plannerSaveCell(td) {
  const key = `${td.dataset.day}_${td.dataset.slot}`;
  const content = td.textContent.trim();
  const color   = td.dataset.color || '';
  const isFixed = td.dataset.fixed === '1';

  clearTimeout(plannerState.saveTimers[key]);
  plannerState.saveTimers[key] = setTimeout(async () => {
    const start = plannerDateStr(plannerState.weekStart);
    try {
      await postJson('/planner/slot', {
        week_start: start,
        day_index:  parseInt(td.dataset.day),
        slot_time:  td.dataset.slot,
        content,
        color: color || null,
        is_fixed: isFixed
      }, 'PUT');
    } catch (_) {}
  }, 400);
}

function plannerApplyColor(color) {
  const td = plannerState.activeCell;
  if (!td) return;
  td.dataset.color = color;
  td.style.background = color || '';
  plannerSaveCell(td);
  updateColorBarSelection(color);
}

function updateColorBarSelection(color) {
  document.querySelectorAll('.planner-swatch').forEach(s => {
    s.classList.toggle('planner-swatch-active', s.dataset.color === (color || ''));
  });
}

function plannerSetFixedForActiveCell(isFixed) {
  const td = plannerState.activeCell;
  if (!td) return;
  td.dataset.fixed = isFixed ? '1' : '';
  plannerSaveCell(td);
}

async function loadPlannerWeek(weekStart) {
  plannerState.weekStart = weekStart;
  document.querySelector('#planner-week-label').textContent = plannerWeekLabel(weekStart);
  document.querySelector('#planner-loading').classList.remove('hidden');

  const start = plannerDateStr(weekStart);
  try {
    const data = await getJson(`/planner/week?start=${start}`);
    const cells = {};
    const activitySlots = {};
    for (const row of (data.slots || [])) {
      cells[`${row.day_index}_${row.slot_time}`] = {
        content: row.content || '',
        color: row.color || '',
        isFixed: row.is_fixed === true
      };
    }
    for (const row of (data.activity_slots || [])) {
      activitySlots[`${row.day_index}_${row.slot_time}`] = {
        eventsCount: Number(row.events_count || 0),
        studyMinutes: Number(row.study_minutes || 0),
        lastEventAt: row.last_event_at || null
      };
    }
    plannerState.cells = cells;
    plannerState.activitySlots = activitySlots;
    document.querySelector('#planner-loading').classList.add('hidden');
    buildPlannerGrid(weekStart, cells, activitySlots);
    plannerMarkCurrentSlot();
  } catch (err) {
    document.querySelector('#planner-loading').textContent = `Error: ${err.message}`;
  }
}

function initPlannerTab() {
  const weekStart = plannerWeekStart(new Date());
  loadPlannerWeek(weekStart);
  plannerState.nowMarkerTimer = setInterval(plannerMarkCurrentSlot, 30000);

  document.addEventListener('mouseup', () => {
    plannerState.fillDrag = null;
  });

  document.querySelector('#planner-prev').addEventListener('click', () => {
    const prev = new Date(plannerState.weekStart);
    prev.setDate(prev.getDate() - 7);
    loadPlannerWeek(prev);
  });
  document.querySelector('#planner-next').addEventListener('click', () => {
    const next = new Date(plannerState.weekStart);
    next.setDate(next.getDate() + 7);
    loadPlannerWeek(next);
  });
  document.querySelector('#planner-today').addEventListener('click', () => {
    loadPlannerWeek(plannerWeekStart(new Date()));
  });

  const fixedToggle = document.querySelector('#planner-fixed-toggle');
  fixedToggle.addEventListener('mousedown', (e) => e.preventDefault());
  fixedToggle.addEventListener('change', () => plannerSetFixedForActiveCell(fixedToggle.checked));

  document.querySelectorAll('.planner-swatch').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => plannerApplyColor(btn.dataset.color));
  });

  initPlannerTodos();
}

// ─── Planner To-do list ────────────────────────────────────────────────────────

function initPlannerTodos() {
  loadPlannerTodos();

  const input  = document.querySelector('#planner-todo-input');
  const addBtn = document.querySelector('#planner-todo-add-btn');

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const todo = await postJson('/planner/todos', { text });
      appendTodoItem(todo);
    } catch (_) {}
  };

  addBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

async function loadPlannerTodos() {
  const list = document.querySelector('#planner-todo-list');
  try {
    const data = await getJson('/planner/todos');
    list.innerHTML = '';
    for (const todo of data.todos ?? []) appendTodoItem(todo);
  } catch (_) {}
}

function appendTodoItem(todo) {
  const list = document.querySelector('#planner-todo-list');
  const li = document.createElement('li');
  li.className = `planner-todo-item${todo.done ? ' done' : ''}`;
  li.dataset.id = todo.id;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'planner-todo-check';
  check.checked = todo.done;
  check.addEventListener('change', async () => {
    const done = check.checked;
    li.classList.toggle('done', done);
    await postJson(`/planner/todos/${todo.id}`, { done }, 'PATCH').catch(() => {});
  });

  const textEl = document.createElement('input');
  textEl.type = 'text';
  textEl.className = 'planner-todo-text';
  textEl.value = todo.text;
  textEl.addEventListener('blur', async () => {
    const text = textEl.value.trim();
    if (!text) { textEl.value = todo.text; return; }
    if (text === todo.text) return;
    todo.text = text;
    await postJson(`/planner/todos/${todo.id}`, { text }, 'PATCH').catch(() => {});
  });
  textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') textEl.blur(); });

  const del = document.createElement('button');
  del.className = 'planner-todo-delete';
  del.textContent = '✕';
  del.title = 'Eliminar';
  del.addEventListener('click', async () => {
    await deleteJson(`/planner/todos/${todo.id}`).catch(() => {});
    li.remove();
  });

  li.append(check, textEl, del);
  list.appendChild(li);
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
          <div class="agenda-card-actions">
            <button type="button" class="btn-ghost agenda-delete-btn" data-card-id="${card.id}">Eliminar</button>
          </div>
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

        const deleteBtn = cardEl.querySelector('.agenda-delete-btn');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', async () => {
            const reason = (window.prompt('Motivo para eliminar la tarjeta (mínimo 5 caracteres):', 'Eliminada desde sección estudio') || '').trim();
            if (!reason) return;
            if (reason.length < 5) {
              alert('Ingresá un motivo de al menos 5 caracteres.');
              return;
            }

            deleteBtn.disabled = true;
            deleteBtn.textContent = 'Eliminando...';
            try {
              await postJson(`/cards/${card.id}/archive`, { reason }, 'PATCH');
              await loadAgenda();
            } catch (err) {
              alert(`No se pudo eliminar la tarjeta: ${err.message}`);
              deleteBtn.disabled = false;
              deleteBtn.textContent = 'Eliminar';
            }
          });
        }
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

  // Load existing config + class notes
  try {
    const [data, classNotesData] = await Promise.all([
      getJson(`/curriculum/${encodeURIComponent(subject)}`),
      getJson(`/curriculum/${encodeURIComponent(subject)}/class-notes`)
    ]);
    document.querySelector('#curriculum-syllabus').value = data.config?.syllabus_text || '';
    document.querySelector('#curriculum-daily-new-limit').value = data.config?.daily_new_cards_limit ?? '';
    document.querySelector('#curriculum-max-micro-per-card').value = data.config?.max_micro_cards_per_card ?? '';
    renderExamDatesList(data.exam_dates || [], subject);
    renderExamsList(data.exams || [], subject);
    renderClassNotesList(classNotesData.class_notes || [], subject);
  } catch (_e) {
    document.querySelector('#curriculum-daily-new-limit').value = '';
    document.querySelector('#curriculum-max-micro-per-card').value = '';
    renderClassNotesList([], subject);
  }

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
  const rawDailyLimit = document.querySelector('#curriculum-daily-new-limit').value.trim();
  const parsedDailyLimit = rawDailyLimit === '' ? null : parseInt(rawDailyLimit, 10);

  if (rawDailyLimit !== '' && (!Number.isFinite(parsedDailyLimit) || parsedDailyLimit < 0)) {
    fb.textContent = 'El límite diario debe ser un entero mayor o igual a 0.';
    fb.style.color = 'var(--fail-fg)';
    return;
  }

  const rawMicroLimit = document.querySelector('#curriculum-max-micro-per-card').value.trim();
  const parsedMicroLimit = rawMicroLimit === '' ? null : parseInt(rawMicroLimit, 10);

  if (rawMicroLimit !== '' && (!Number.isFinite(parsedMicroLimit) || parsedMicroLimit < 0)) {
    fb.textContent = 'El límite de micro-tarjetas debe ser un entero mayor o igual a 0.';
    fb.style.color = 'var(--fail-fg)';
    return;
  }

  try {
    await postJson(`/curriculum/${encodeURIComponent(subject)}`, {
      syllabus_text:              document.querySelector('#curriculum-syllabus').value,
      daily_new_cards_limit:      parsedDailyLimit,
      max_micro_cards_per_card:   parsedMicroLimit
    }, 'PUT');
    fb.textContent = 'Guardado.';
    fb.style.color = 'var(--pass-fg)';
  } catch (err) {
    fb.textContent = `Error: ${err.message}`;
    fb.style.color = 'var(--fail-fg)';
  }
});

// ── GitHub import ─────────────────────────────────────────────────────────────

document.querySelector('#github-import-btn').addEventListener('click', async () => {
  const subject = document.querySelector('#curriculum-modal').dataset.subject;
  const url     = (document.querySelector('#github-repo-url').value || '').trim();
  const fb      = document.querySelector('#github-import-feedback');
  const btn     = document.querySelector('#github-import-btn');

  if (!url) {
    fb.textContent = 'Pegá una URL de GitHub.';
    fb.style.color = 'var(--fail-fg)';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Importando...';
  fb.textContent = 'Leyendo repositorio y generando tarjetas (puede tardar 15-20s)...';
  fb.style.color = 'var(--text-muted)';

  try {
    const data = await postJson('/import/github', { repo_url: url, subject });
    const n = data.cards_created;
    fb.textContent = `${n} tarjeta${n !== 1 ? 's' : ''} creada${n !== 1 ? 's' : ''}. Aparecerán en tu cola de estudio.`;
    fb.style.color = 'var(--pass-fg)';
    document.querySelector('#github-repo-url').value = '';
  } catch (err) {
    fb.textContent = `Error: ${err.message}`;
    fb.style.color = 'var(--fail-fg)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Importar';
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
      } catch (_e) {
    document.querySelector('#curriculum-daily-new-limit').value = '';
  }
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
      } catch (_e) {
    document.querySelector('#curriculum-daily-new-limit').value = '';
  }
    });
  });
}

// ── Class notes (per-class entries) ───────────────────────────────────────────

function renderClassNotesList(classNotes, subject) {
  const list = document.querySelector('#class-notes-list');
  list.innerHTML = '';

  if (!classNotes.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;margin:0 0 4px">Sin clases cargadas.</p>';
  } else {
    classNotes.forEach(note => appendClassNoteCard(note, subject, list));
  }

  // Wire "Agregar clase" button (replace listener to avoid duplicates)
  const addBtn = document.querySelector('#class-note-add-btn');
  const newAddBtn = addBtn.cloneNode(true);
  addBtn.parentNode.replaceChild(newAddBtn, addBtn);
  newAddBtn.addEventListener('click', async () => {
    try {
      const created = await postJson(`/curriculum/${encodeURIComponent(subject)}/class-notes`, {
        title: '', content: ''
      });
      // Remove empty-state message if present
      const emptyMsg = list.querySelector('p');
      if (emptyMsg) emptyMsg.remove();
      appendClassNoteCard(created, subject, list);
      // Scroll to the new card and focus title
      const newCard = list.lastElementChild;
      newCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      newCard?.querySelector('.class-note-title-input')?.focus();
    } catch (err) {
      console.error('Error adding class note:', err);
    }
  });
}

function appendClassNoteCard(note, subject, container) {
  const card = document.createElement('div');
  card.className = 'class-note-card';
  card.dataset.id = note.id;

  const displayTitle = note.title || 'Sin título';
  card.innerHTML = `
    <div class="class-note-header">
      <button type="button" class="class-note-toggle" aria-expanded="true">▾</button>
      <input type="text" class="class-note-title-input" value="${escHtml(note.title || '')}" placeholder="Título de la clase" maxlength="200">
      <button type="button" class="class-note-delete btn-ghost" style="font-size:0.72rem;padding:1px 7px">Eliminar</button>
    </div>
    <div class="class-note-body">
      <textarea class="class-note-content" placeholder="Contenido de la clase..." maxlength="5000">${escHtml(note.content || '')}</textarea>
      <span class="class-note-save-status"></span>
    </div>`;

  let saveTimer = null;
  const saveStatus = card.querySelector('.class-note-save-status');

  async function saveNote(fields) {
    saveStatus.textContent = 'Guardando...';
    try {
      await postJson(`/curriculum/${encodeURIComponent(subject)}/class-notes/${note.id}`, fields, 'PATCH');
      saveStatus.textContent = 'Guardado';
      setTimeout(() => { saveStatus.textContent = ''; }, 2000);
    } catch (_e) {
      saveStatus.textContent = 'Error al guardar';
    }
  }

  const titleInput = card.querySelector('.class-note-title-input');
  titleInput.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNote({ title: titleInput.value }), 800);
  });

  const contentTextarea = card.querySelector('.class-note-content');
  contentTextarea.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNote({ content: contentTextarea.value }), 800);
  });

  const toggleBtn = card.querySelector('.class-note-toggle');
  const body = card.querySelector('.class-note-body');
  toggleBtn.addEventListener('click', () => {
    const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
    toggleBtn.setAttribute('aria-expanded', String(!expanded));
    toggleBtn.textContent = expanded ? '▸' : '▾';
    body.style.display = expanded ? 'none' : '';
  });

  card.querySelector('.class-note-delete').addEventListener('click', async () => {
    try {
      await deleteJson(`/curriculum/${encodeURIComponent(subject)}/class-notes/${note.id}`);
      card.remove();
      const list = document.querySelector('#class-notes-list');
      if (!list.children.length) {
        list.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;margin:0 0 4px">Sin clases cargadas.</p>';
      }
    } catch (_e) {}
  });

  container.appendChild(card);
}

// ─── Advisor chat ─────────────────────────────────────────────────────────────

let _advisorChatHistory = [];
let _advisorChatSubject = null;

function resetAdvisorChat(subject) {
  _advisorChatHistory = [];
  _advisorChatSubject = subject;
  const msgs = document.querySelector('#advisor-chat-messages');
  if (msgs) msgs.innerHTML = '';
}

function appendChatMsg(role, text) {
  const msgs = document.querySelector('#advisor-chat-messages');
  const el = document.createElement('div');
  el.className = `advisor-chat-msg ${role}`;
  // Minimal markdown: **bold**, newlines
  el.innerHTML = escHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}

async function sendAdvisorChatMessage() {
  const input   = document.querySelector('#advisor-chat-input');
  const sendBtn = document.querySelector('#advisor-chat-send');
  const message = input.value.trim();
  if (!message || !_advisorChatSubject) return;

  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;

  appendChatMsg('user', message);
  const thinkingEl = appendChatMsg('assistant thinking', '...');

  try {
    const data = await postJson('/advisor/chat', {
      subject: _advisorChatSubject,
      message,
      history: _advisorChatHistory,
    });

    thinkingEl.remove();
    appendChatMsg('assistant', data.reply || 'Sin respuesta.');

    _advisorChatHistory.push({ role: 'user',      content: message     });
    _advisorChatHistory.push({ role: 'assistant', content: data.reply  });
    // Keep bounded
    if (_advisorChatHistory.length > 20) _advisorChatHistory = _advisorChatHistory.slice(-20);
  } catch (err) {
    thinkingEl.remove();
    appendChatMsg('assistant', `Error: ${err.message}`);
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

document.querySelector('#advisor-chat-send').addEventListener('click', sendAdvisorChatMessage);
document.querySelector('#advisor-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAdvisorChatMessage(); }
});

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
      appendChatMsg('assistant',
        `No hay programa configurado para ${subject}, pero igual puedo ayudarte. Podés pedirme un cronograma basado en tu historial, estimaciones de tiempo, o cualquier consulta sobre tu progreso.`
      );
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

    appendChatMsg('assistant',
      `Análisis de ${subject} listo. Podés pedirme un cronograma semana a semana, que estime cuánto tiempo te falta para dominar los temas pendientes, o preguntarme lo que quieras sobre tu progreso.`
    );
  } catch (err) {
    loading.classList.add('hidden');
    content.innerHTML = `<p style="color:var(--fail-fg)">Error al analizar: ${err.message}</p>`;
    appendChatMsg('assistant',
      `Hubo un error al cargar el análisis de ${subject}, pero igual podés preguntarme lo que necesites.`
    );
  }
}

// ─── Notes panel ──────────────────────────────────────────────────────────────
let notesSaveTimer = null;

async function initNotes() {
  const fab      = document.getElementById('notes-fab');
  const panel    = document.getElementById('notes-panel');
  const closeBtn = document.getElementById('notes-panel-close');
  const textarea = document.getElementById('notes-content');
  const status   = document.getElementById('notes-save-status');

  // Load saved notes
  try {
    const data = await getJson('/notes');
    textarea.value = data.content || '';
  } catch (_) {}

  // Toggle panel open/close via FAB
  fab.addEventListener('click', () => {
    const isOpen = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', isOpen);
    fab.classList.toggle('active', !isOpen);
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.add('hidden');
    fab.classList.remove('active');
  });

  // Auto-save with 800ms debounce
  textarea.addEventListener('input', () => {
    status.textContent = '';
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(async () => {
      status.textContent = 'Guardando...';
      try {
        await postJson('/notes', { content: textarea.value }, 'PUT');
        status.textContent = 'Guardado';
        setTimeout(() => { status.textContent = ''; }, 2000);
      } catch (_) {
        status.textContent = 'Error al guardar';
      }
    }, 800);
  });
}
