// ─── Theme ────────────────────────────────────────────────────────────────────
(function initTheme() {
  const stored = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = stored ?? (prefersDark ? 'dark' : 'light');

  function applyTheme(isDark) {
    if (isDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = isDark ? '☀' : '☾';
      btn.title = isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
    }
  }

  applyTheme(theme === 'dark');

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#theme-toggle')) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
    applyTheme(!isDark);
  });
})();

const EVALUATE_ENDPOINT = '/evaluate';
const DECISION_ENDPOINT = '/decision';
let pendingStudySubject = null;
const advisorCoverageCache = new Map();

// ─── User settings (loaded once on startup) ───────────────────────────────────
let userSettings = {
  session_planning_enabled:   true,
  gratitude_enabled:          true,
  time_restriction_enabled:   true,
  planner_gate_enabled:       true,
  realtime_break_notifications_enabled: true,
  default_retention_floor:    null,   // integer 50-99, null = use hardcoded 75
  default_grading_strictness: null,   // integer 0-10,  null = use hardcoded 5
};

// localStorage-backed UX preferences (no server persistence needed)
function getTTSEnabled()          { return localStorage.getItem('discriminador_tts_enabled') !== 'false'; }
function setTTSEnabled(v)         { localStorage.setItem('discriminador_tts_enabled', v ? 'true' : 'false'); }
function getDefaultBriefingTime() { return localStorage.getItem('discriminador_briefing_time') || ''; }
function setDefaultBriefingTime(v){ if (v) localStorage.setItem('discriminador_briefing_time', String(v)); else localStorage.removeItem('discriminador_briefing_time'); }
function getDefaultBriefingEnergy(){ return localStorage.getItem('discriminador_briefing_energy') || ''; }
function setDefaultBriefingEnergy(v){ if (v) localStorage.setItem('discriminador_briefing_energy', String(v)); else localStorage.removeItem('discriminador_briefing_energy'); }

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
  const confirmField = document.getElementById('auth-confirm-field');
  const submitBtn = document.getElementById('auth-submit-btn');

  function applyMode(m) {
    mode = m;
    tabs.forEach(x => x.classList.toggle('active', x.dataset.tab === mode));
    document.getElementById('auth-error').classList.add('hidden');
    const isRegister = mode === 'register';
    confirmField.classList.toggle('hidden', !isRegister);
    submitBtn.textContent = isRegister ? 'Crear cuenta' : 'Entrar';
    document.getElementById('auth-password').autocomplete = isRegister ? 'new-password' : 'current-password';
  }

  tabs.forEach(t => t.addEventListener('click', () => applyMode(t.dataset.tab)));

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const errEl = document.getElementById('auth-error');

    if (mode === 'register') {
      const confirm = document.getElementById('auth-confirm').value;
      if (password !== confirm) {
        errEl.textContent = 'Las contraseñas no coinciden.';
        errEl.classList.remove('hidden');
        return;
      }
      if (password.length < 6) {
        errEl.textContent = 'La contraseña debe tener al menos 6 caracteres.';
        errEl.classList.remove('hidden');
        return;
      }
    }

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

// Load user settings early so feature flags are ready before any tab is used
getJson('/settings').then((s) => { Object.assign(userSettings, s); }).catch((err) => {
  console.warn('[settings] Failed to load user settings:', err.message);
});

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
    settings:  document.querySelector('#tab-settings'),
    documents:   document.querySelector('#tab-documents'),
    transcripts: document.querySelector('#tab-transcripts'),
  };
  let loaded = { dashboard: false, study: false, explore: false, browser: false, planner: false, progress: false, settings: false, documents: false, transcripts: false };

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
        loaded.study = true;
        // When the user intentionally navigates from the dashboard to a specific subject,
        // discard any stale persisted session so they get the current full queue.
        if (fromDashboard && pendingStudySubject) clearPersistedStudySession();
        applyStudySubjectFilter(pendingStudySubject); // set BEFORE init so restorePersistedStudySession sees it
        initStudyTab();
        applyStudySubjectFilter(pendingStudySubject); // re-apply AFTER in case restore overwrote it
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
      } else if (tab === 'settings' && !loaded.settings) {
        loaded.settings = true; initSettingsTab();
      } else if (tab === 'documents' && !loaded.documents) {
        loaded.documents = true; initDocumentsTab();
      } else if (tab === 'transcripts' && !loaded.transcripts) {
        loaded.transcripts = true; initTranscriptsTab();
      }

      // Dashboard "Estudiar" subject button → skip briefing, go straight to the
      // subject-filtered overview so the user can start reviewing immediately.
      // Always clear any stale persisted session and force a fresh overview load.
      const normalizedPending = typeof pendingStudySubject === 'string' ? pendingStudySubject.trim() : '';
      if (tab === 'study' && fromDashboard && normalizedPending) {
        clearPersistedStudySession(); // discard any stale session that may have been restored
        applyStudySubjectFilter(normalizedPending); // guarantee the filter is set
        document.querySelector('#study-session').classList.add('hidden');
        document.querySelector('#study-briefing').classList.add('hidden');
        document.querySelector('#study-complete').classList.add('hidden');
        document.querySelector('#study-overview').classList.remove('hidden');
        loadStudyOverview();
      }
    });
  });

  // Show dashboard on load
  showTab('dashboard');
  loaded.dashboard = true;
  loadDashboard();
})();

initNotes();

/* ── Code-wrap buttons ───────────────────────────────────────────────────────
   Any button with class "code-wrap-btn" and data-target="<textarea-id>"
   wraps the current selection (or inserts a blank block) in triple backticks.
   Works for inline snippets too: if the selection has no newlines, wraps in
   single backticks instead.
*/
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.code-wrap-btn');
  if (!btn) return;
  const ta = document.getElementById(btn.dataset.target);
  if (!ta) return;

  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  const sel   = ta.value.slice(start, end);

  let before, after, newSel;
  if (!sel) {
    // Nothing selected — insert an empty code block and park cursor inside.
    before  = '```\n';
    newSel  = '';
    after   = '\n```';
  } else if (sel.includes('\n')) {
    // Multi-line → fenced block.
    before = '```\n';
    newSel = sel;
    after  = '\n```';
  } else {
    // Single line → inline backtick.
    before = '`';
    newSel = sel;
    after  = '`';
  }

  ta.focus();
  ta.setRangeText(before + newSel + after, start, end, 'select');
  // Place cursor just after the opening fence (inside the block).
  if (!sel) {
    const cur = start + before.length;
    ta.setSelectionRange(cur, cur);
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});

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
    body.innerHTML = '<tr><td colspan="10" style="color:var(--text-muted)">No hay tarjetas para este filtro.</td></tr>';
    return;
  }

  body.innerHTML = rows.map((card) => {
    const status    = getCardStatus(card);
    const reviews   = Number(card.review_count || 0);
    const passes    = Number(card.pass_count   || 0);
    const lapses    = Math.max(0, reviews - passes);
    const passRate  = reviews > 0 ? Math.round((passes / reviews) * 100) : '—';
    const intervalD = card.interval_days != null ? Math.round(Number(card.interval_days)) : '—';
    const micros    = Number(card.active_micro_count || 0);
    const variants  = Number(card.variant_count || 0);
    const typePills = [];
    if (micros > 0) typePills.push(`<span class="browser-type-pill micro">${micros} micro</span>`);
    if (variants > 0) typePills.push(`<span class="browser-type-pill variant">${variants} var.</span>`);
    if (!typePills.length) typePills.push('<span class="browser-type-pill base">Base</span>');
    return `
      <tr class="browser-data-row" data-id="${card.id}">
        <td><input type="checkbox" class="browser-row-check" data-id="${card.id}" ${browserState.selected.has(card.id) ? 'checked' : ''}></td>
        <td>${escHtml(card.subject || '(sin materia)')}</td>
        <td class="browser-prompt">${escHtml(card.prompt_text || '')}</td>
        <td>${typePills.join(' ')}</td>
        <td>${formatNextReview(card.next_review_at)}</td>
        <td>${intervalD === '—' ? '—' : intervalD + 'd'}</td>
        <td><span class="browser-status-pill ${status}">${status}</span></td>
        <td>${passRate === '—' ? '—' : passRate + '%'}</td>
        <td>${lapses}</td>
        <td><button class="browser-detail-btn" data-id="${card.id}" title="Ver detalle">Ver más</button></td>
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

  body.querySelectorAll('.browser-detail-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id   = Number(btn.dataset.id);
      const card = browserState.cards.find((c) => c.id === id);
      if (card) showCardDetail(card);
    });
  });
}

/* ── Card detail popup ───────────────────────────────────────────────────── */

function forgettingCurveSVG(intervalDays, lastReviewedAt, nextReviewAt) {
  const W = 400, H = 130, PAD_L = 36, PAD_B = 24, PAD_T = 10, PAD_R = 10;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_B - PAD_T;

  // Stability: at t = interval_days, retention ≈ 90 %
  const stability = intervalDays > 0 ? -intervalDays / Math.log(0.9) : 10;
  const totalDays = Math.max(intervalDays * 2.5, 14);

  const retention = (t) => Math.exp(-t / stability);
  const xScale    = (t) => PAD_L + (t / totalDays) * plotW;
  const yScale    = (r) => PAD_T + (1 - r) * plotH;

  // Build curve path
  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const t = (i / 80) * totalDays;
    pts.push(`${xScale(t).toFixed(1)},${yScale(retention(t)).toFixed(1)}`);
  }

  // Today marker
  const now = new Date();
  let todayX = null;
  if (lastReviewedAt) {
    const daysSince = (now - new Date(lastReviewedAt)) / 86400000;
    if (daysSince >= 0 && daysSince <= totalDays) {
      todayX = xScale(daysSince);
    }
  }

  // Next review marker
  let nextX = null, nextRetention = null;
  if (nextReviewAt) {
    const daysToNext = (new Date(nextReviewAt) - (lastReviewedAt ? new Date(lastReviewedAt) : now)) / 86400000;
    if (daysToNext >= 0 && daysToNext <= totalDays) {
      nextX = xScale(daysToNext);
      nextRetention = retention(daysToNext);
    }
  }

  // X-axis labels
  const tickCount = 5;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const t = (i / tickCount) * totalDays;
    return `<text x="${xScale(t).toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="#999">${Math.round(t)}d</text>`;
  }).join('');

  // Y-axis labels
  const yLabels = [100, 90, 70, 50].map((pct) => {
    const y = yScale(pct / 100).toFixed(1);
    return `<text x="${PAD_L - 3}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#bbb">${pct}%</text>
            <line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#eee" stroke-width="0.5"/>`;
  }).join('');

  // Shade danger zone (below 70%)
  const y70 = yScale(0.7).toFixed(1);
  const dangerPath = `M${PAD_L},${y70} L${W - PAD_R},${y70} L${W - PAD_R},${PAD_T + plotH} L${PAD_L},${PAD_T + plotH} Z`;

  const todayMarker = todayX
    ? `<line x1="${todayX.toFixed(1)}" y1="${PAD_T}" x2="${todayX.toFixed(1)}" y2="${PAD_T + plotH}" stroke="#e67e22" stroke-width="1.5" stroke-dasharray="3,2"/>
       <circle cx="${todayX.toFixed(1)}" cy="${yScale(retention((now - new Date(lastReviewedAt)) / 86400000)).toFixed(1)}" r="3.5" fill="#e67e22"/>`
    : '';

  const nextMarker = nextX != null
    ? `<line x1="${nextX.toFixed(1)}" y1="${PAD_T}" x2="${nextX.toFixed(1)}" y2="${PAD_T + plotH}" stroke="#27ae60" stroke-width="1.5" stroke-dasharray="3,2"/>
       <circle cx="${nextX.toFixed(1)}" cy="${yScale(nextRetention).toFixed(1)}" r="3.5" fill="#27ae60"/>`
    : '';

  return `
    <defs>
      <clipPath id="cdp-clip"><rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}"/></clipPath>
    </defs>
    ${yLabels}
    <path d="${dangerPath}" fill="#fff0f0" opacity="0.7" clip-path="url(#cdp-clip)"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="#4a90d9" stroke-width="2" clip-path="url(#cdp-clip)"/>
    ${todayMarker}
    ${nextMarker}
    ${ticks}
    <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + plotH}" stroke="#ccc" stroke-width="1"/>
    <line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}" stroke="#ccc" stroke-width="1"/>
  `;
}

function showCardDetail(card) {
  const overlay = document.querySelector('#card-detail-overlay');
  if (!overlay) return;

  const reviews  = Number(card.review_count || 0);
  const passes   = Number(card.pass_count   || 0);
  const lapses   = Math.max(0, reviews - passes);
  const passRate = reviews > 0 ? Math.round((passes / reviews) * 100) + '%' : '—';
  const status   = getCardStatus(card);
  const intervalD = card.interval_days != null ? Math.round(Number(card.interval_days)) : 1;

  document.querySelector('#cdp-badge').textContent = status;
  document.querySelector('#cdp-badge').className = `browser-status-pill ${status}`;
  document.querySelector('#cdp-subject').textContent = card.subject ? ` · ${card.subject}` : '';
  document.querySelector('#cdp-prompt').innerHTML  = formatPromptForDisplay(card.prompt_text || '');
  document.querySelector('#cdp-answer').innerHTML  = renderCodeMarkdown(card.expected_answer_text || '');

  document.querySelector('#cdp-reviews').textContent  = reviews;
  document.querySelector('#cdp-pass-rate').textContent = passRate;
  document.querySelector('#cdp-lapses').textContent   = lapses;
  document.querySelector('#cdp-interval').textContent = intervalD + 'd';
  document.querySelector('#cdp-ease').textContent     = card.ease_factor != null ? Number(card.ease_factor).toFixed(2) : '—';
  document.querySelector('#cdp-micros').textContent   = Number(card.active_micro_count || 0);
  document.querySelector('#cdp-variants').textContent = Number(card.variant_count || 0);
  document.querySelector('#cdp-created').textContent  = card.created_at
    ? new Date(card.created_at).toLocaleDateString('es-AR') : '—';

  const fmt = (v) => v ? new Date(v).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  document.querySelector('#cdp-last-reviewed').textContent = fmt(card.last_reviewed_at);
  document.querySelector('#cdp-next-review').textContent   = fmt(card.next_review_at);

  // Forgetting curve
  const svg = document.querySelector('#cdp-curve-svg');
  svg.innerHTML = forgettingCurveSVG(intervalD, card.last_reviewed_at, card.next_review_at);

  // Notes
  const notesEl = document.querySelector('#cdp-notes');
  if (card.notes) {
    notesEl.textContent = card.notes;
    notesEl.classList.remove('hidden');
  } else {
    notesEl.classList.add('hidden');
  }

  loadVariantsTree(card.id, Number(card.variant_count || 0) + Number(card.active_micro_count || 0));

  overlay.classList.remove('hidden');
  document.querySelector('#card-detail-close').focus();
}

function hideCardDetail() {
  document.querySelector('#card-detail-overlay')?.classList.add('hidden');
}

async function loadVariantsTree(cardId, variantCount) {
  const section = document.querySelector('#cdp-variants-section');
  const treeEl  = document.querySelector('#cdp-variants-tree');
  if (!section || !treeEl) return;

  section.classList.remove('hidden');
  treeEl.innerHTML = '<div class="cvt-loading">Cargando…</div>';

  try {
    const data = await getJson(`/scheduler/cards/${cardId}/variants`);
    const hasVariants = data.variants?.length > 0;
    const hasMicros   = data.micros?.length > 0;

    if (!hasVariants && !hasMicros) {
      section.classList.add('hidden');
      treeEl.innerHTML = '';
      return;
    }

    treeEl.innerHTML = renderCardTreeHTML(data.card, data.variants ?? [], data.micros ?? []);

    treeEl.querySelectorAll('.cvt-node').forEach((node) => {
      node.querySelector('.cvt-node-head').addEventListener('click', (e) => {
        if (e.target.closest('.cvt-delete-btn')) return;
        node.classList.toggle('cvt-node--expanded');
      });
    });

    treeEl.querySelectorAll('.cvt-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const variantId = btn.dataset.variantId;
        if (!confirm('¿Eliminar esta variante?')) return;
        btn.disabled = true;
        try {
          await deleteJson(`/scheduler/cards/${cardId}/variants/${variantId}`);
          const countEl = document.querySelector('#cdp-variants');
          const newCount = Math.max(0, Number(countEl?.textContent || 0) - 1);
          if (countEl) countEl.textContent = newCount;
          await loadVariantsTree(cardId, newCount);
        } catch (err) {
          showToast(`Error al eliminar variante: ${err.message}`, 'error');
          btn.disabled = false;
        }
      });
    });
  } catch (_) {
    treeEl.innerHTML = '<div class="cvt-error">No se pudieron cargar las variantes.</div>';
  }
}

function renderCardTreeHTML(card, variants, micros) {
  const trunc = (s, n) => s && s.length > n ? s.slice(0, n) + '…' : (s || '');

  const reviewPill = (reviewCount, passCount) => {
    if (!reviewCount) return '<span class="cvt-review-pill cvt-review-pill--zero">sin repasos</span>';
    const pct = Math.round((passCount / reviewCount) * 100);
    const cls = pct >= 70 ? 'good' : pct >= 40 ? 'mid' : 'low';
    return `<span class="cvt-review-pill cvt-review-pill--${cls}">${reviewCount}× · ${pct}%</span>`;
  };

  const variantTypePill = (type) => {
    if (type === 'listening') return '<span class="cvt-type-pill cvt-type-listening">🎧 listening</span>';
    return '<span class="cvt-type-pill cvt-type-regular">🔀 regular</span>';
  };

  const nodeHTML = (label, prompt, answer, isRoot, variantId = null, reviewCount = 0, passCount = 0, variantType = null) => `
    <div class="cvt-node${isRoot ? ' cvt-node--root' : ''}">
      <div class="cvt-node-head">
        <span class="cvt-node-badge">${escHtml(label)}</span>
        ${variantType ? variantTypePill(variantType) : ''}
        <span class="cvt-node-prompt">${escHtml(trunc(prompt, 60))}</span>
        ${reviewPill(reviewCount, passCount)}
        ${variantId != null ? `<button class="cvt-delete-btn" data-variant-id="${variantId}" title="Eliminar variante" aria-label="Eliminar variante">✕</button>` : ''}
        <span class="cvt-chevron" aria-hidden="true">▾</span>
      </div>
      <div class="cvt-node-body">
        <div class="cvt-node-full-prompt">${escHtml(prompt)}</div>
        <div class="cvt-node-answer-label">Respuesta esperada</div>
        <div class="cvt-node-answer">${escHtml(answer)}</div>
      </div>
    </div>`;

  const rootHTML = nodeHTML(
    `#${card.id} · Original`,
    card.prompt_text, card.expected_answer_text,
    true, null,
    Number(card.review_count || 0), Number(card.pass_count || 0)
  );

  const childrenHTML = variants.map((v, i) => `
    <div class="cvt-branch">
      ${nodeHTML(
        `Variante ${i + 1}`,
        v.prompt_text, v.expected_answer_text,
        false, v.id,
        Number(v.review_count || 0), Number(v.pass_count || 0), v.variant_type
      )}
    </div>`).join('');

  const microsHTML = micros.length ? `
    <div class="cvt-micro-section">
      <div class="cvt-micro-header">
        <span class="cvt-micro-title">Micro-tarjetas</span>
        <span class="cvt-micro-counts">
          ${micros.filter(m => m.status === 'active').length} activa${micros.filter(m => m.status === 'active').length !== 1 ? 's' : ''}
          · ${micros.filter(m => m.status === 'archived').length} archivada${micros.filter(m => m.status === 'archived').length !== 1 ? 's' : ''}
        </span>
      </div>
      <div class="cvt-micro-list">
        ${micros.map(m => `
          <div class="cvt-micro-item cvt-micro-item--${m.status}">
            <span class="cvt-micro-status-dot" title="${m.status === 'active' ? 'Activa' : 'Archivada'}"></span>
            <span class="cvt-micro-concept">${escHtml(m.concept)}</span>
            <span class="cvt-micro-question" title="${escHtml(m.question)}">${escHtml(trunc(m.question, 55))}</span>
            <span class="cvt-micro-reviews">${Number(m.review_count || 0)}×</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  return `<div class="cvt-root">
    ${rootHTML}
    ${variants.length ? `<div class="cvt-children">${childrenHTML}</div>` : ''}
    ${microsHTML}
  </div>`;
}

document.querySelector('#card-detail-close')?.addEventListener('click', hideCardDetail);
document.querySelector('#card-detail-overlay')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideCardDetail();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideCardDetail();
});

async function loadBrowserCards() {
  const response = await getJson('/cards/browser');
  browserState.cards = response?.cards || [];
  browserState.selected.clear();
  renderBrowserTable();
}

async function runBrowserBatchAction(action) {
  const ids = [...browserState.selected];
  if (!ids.length) {
    showToast('Seleccioná al menos una tarjeta.', 'error');
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
      showToast('Ingresá el nombre de la materia destino.', 'error');
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
    showToast(`Acción aplicada en ${result.updated ?? 0} tarjeta(s).`, 'success');
    await loadBrowserCards();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function initBrowserTab() {
  const textEl = document.querySelector('#browser-filter-text');
  const subjectEl = document.querySelector('#browser-filter-subject');
  const statusEl = document.querySelector('#browser-filter-status');
  const selectAllEl = document.querySelector('#browser-select-all');

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
  document.querySelector('#browser-detect-redundant-btn')?.addEventListener('click', openDetectRedundantModal);
  document.querySelector('#browser-reformat-latex-btn')?.addEventListener('click', openReformatLatexModal);

  loadBrowserCards().catch((err) => {
    showToast(`Error al cargar navegador: ${err.message}`, 'error');
  });

  initAiExtraction();
}

// ── AI-assisted bulk card extraction ─────────────────────────────────────────

function initAiExtraction() {
  const toggleBtn   = document.querySelector('#ai-extraction-toggle');
  const body        = document.querySelector('#ai-extraction-body');
  const extractBtn  = document.querySelector('#ai-extract-btn');
  const statusEl    = document.querySelector('#ai-extract-status');
  const candidatesWrap = document.querySelector('#ai-candidates-wrap');
  const candidatesList = document.querySelector('#ai-candidates-list');
  const candidatesCount = document.querySelector('#ai-candidates-count');
  const saveFeedback = document.querySelector('#ai-save-feedback');
  const saveBtn     = document.querySelector('#ai-save-btn');
  const selectAllBtn   = document.querySelector('#ai-select-all-btn');
  const deselectAllBtn = document.querySelector('#ai-deselect-all-btn');

  if (!toggleBtn || !body) return;

  // Collapse/expand
  toggleBtn.addEventListener('click', () => {
    const isHidden = body.classList.contains('hidden');
    body.classList.toggle('hidden', !isHidden);
    toggleBtn.textContent = isHidden ? 'Colapsar' : 'Expandir';
  });

  // State: array of candidate card objects with client-side fields
  let candidates = [];

  function statusBadge(status) {
    const map = { ready: '✓ lista', ambiguous: '? ambigua', needs_edit: '✎ revisar', rejected: '✕ rechazada' };
    return map[status] || status;
  }

  function confidencePct(c) {
    return typeof c === 'number' ? `${Math.round(c * 100)}%` : '—';
  }

  function renderCandidates() {
    candidatesList.innerHTML = '';
    if (!candidates.length) return;

    candidates.forEach((card, idx) => {
      const div = document.createElement('div');
      div.className = 'ai-candidate-card';
      div.dataset.idx = idx;

      const autoSelected = card.status === 'ready';
      const checked = card._selected !== undefined ? card._selected : autoSelected;
      card._selected = checked;

      const statusClass = `ai-status-${card.status}`;

      const total = candidates.length;
      const diffScoreHTML = card.difficulty_score != null
        ? `<span class="ai-difficulty-score" title="Dificultad relativa al lote">🎯 ${card.difficulty_score}/${total}</span>`
        : '';

      div.innerHTML = `
        <div class="ai-candidate-header">
          <label class="ai-candidate-check">
            <input type="checkbox" class="ai-card-checkbox" data-idx="${idx}" ${checked ? 'checked' : ''}>
            <span class="ai-status-badge ${statusClass}">${escHtml(statusBadge(card.status))}</span>
            <span class="ai-confidence">Confianza: ${confidencePct(card.confidence)}</span>
            ${diffScoreHTML}
          </label>
          <button type="button" class="btn-ghost ai-discard-btn" data-idx="${idx}" style="font-size:0.8rem;padding:2px 8px">Descartar</button>
        </div>
        <div class="ai-candidate-fields">
          <label style="font-size:0.78rem;color:var(--text-muted)">Pregunta</label>
          <textarea class="ai-edit-question" data-idx="${idx}" rows="2" style="width:100%;box-sizing:border-box;resize:vertical">${escHtml(card.question)}</textarea>
          <label style="font-size:0.78rem;color:var(--text-muted)">Respuesta</label>
          <textarea class="ai-edit-answer" data-idx="${idx}" rows="2" style="width:100%;box-sizing:border-box;resize:vertical">${escHtml(card.answer)}</textarea>
          ${card.source_excerpt ? `<details class="ai-source-excerpt"><summary style="font-size:0.78rem;color:var(--text-muted);cursor:pointer">Fragmento fuente</summary><blockquote style="margin:4px 0 0;font-size:0.8rem;color:var(--text-muted);border-left:3px solid var(--border);padding-left:8px">${escHtml(card.source_excerpt)}</blockquote></details>` : ''}
          ${card.notes ? `<p style="font-size:0.78rem;color:#b07d00;margin:4px 0 0"><em>${escHtml(card.notes)}</em></p>` : ''}
        </div>`;

      candidatesList.appendChild(div);
    });

    // Bind events
    candidatesList.querySelectorAll('.ai-card-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const i = parseInt(cb.dataset.idx, 10);
        candidates[i]._selected = cb.checked;
      });
    });

    candidatesList.querySelectorAll('.ai-edit-question').forEach(ta => {
      ta.addEventListener('input', () => {
        candidates[parseInt(ta.dataset.idx, 10)].question = ta.value;
      });
    });

    candidatesList.querySelectorAll('.ai-edit-answer').forEach(ta => {
      ta.addEventListener('input', () => {
        candidates[parseInt(ta.dataset.idx, 10)].answer = ta.value;
      });
    });

    candidatesList.querySelectorAll('.ai-discard-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.idx, 10);
        candidates.splice(i, 1);
        renderCandidates();
        updateCount();
      });
    });
  }

  function updateCount() {
    const total = candidates.length;
    const selected = candidates.filter(c => c._selected).length;
    candidatesCount.textContent = `${total} tarjeta(s) extraída(s) · ${selected} seleccionada(s)`;
  }

  // Select / deselect all
  selectAllBtn?.addEventListener('click', () => {
    candidates.forEach(c => { c._selected = true; });
    renderCandidates();
    updateCount();
  });

  deselectAllBtn?.addEventListener('click', () => {
    candidates.forEach(c => { c._selected = false; });
    renderCandidates();
    updateCount();
  });

  // Extract
  // Split text into chunks that fit within the backend's token budget.
  // Prefers splitting at newlines; falls back to the hard size limit.
  function chunkText(text, size = 12000, overlap = 300) {
    if (text.length <= size) return [text];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      if (end < text.length) {
        const nl = text.lastIndexOf('\n', end);
        if (nl > start + size * 0.6) end = nl + 1;
      }
      chunks.push(text.slice(start, end));
      if (end >= text.length) break;
      start = end - overlap;
    }
    return chunks;
  }

  extractBtn?.addEventListener('click', async () => {
    const text = document.querySelector('#ai-extract-text')?.value?.trim() ?? '';
    if (!text) {
      statusEl.textContent = 'Ingresá el texto antes de extraer.';
      statusEl.style.color = '#c00';
      return;
    }

    const subject = document.querySelector('#ai-extract-subject')?.value?.trim() || undefined;
    const chunks = chunkText(text);

    extractBtn.disabled = true;
    candidatesWrap.classList.add('hidden');
    saveFeedback.textContent = '';

    const seenQuestions = new Set();
    const merged = [];
    const userWarnings = [];
    let hadError = false;

    for (let i = 0; i < chunks.length; i++) {
      statusEl.textContent = chunks.length > 1
        ? `Procesando fragmento ${i + 1} de ${chunks.length}…`
        : 'Extrayendo tarjetas con IA…';
      statusEl.style.color = 'var(--text-muted)';

      try {
        const data = await postJson('/cards/extract-candidates', { text: chunks[i], subject });
        for (const card of (data.cards || [])) {
          const key = card.question.toLowerCase().replace(/\s+/g, ' ');
          if (!seenQuestions.has(key)) {
            seenQuestions.add(key);
            merged.push({ ...card, _selected: card.status === 'ready' });
          }
        }
        // Surface only meaningful warnings (skip internal truncation noise)
        for (const w of (data.warnings || [])) {
          if (!w.includes('truncado') && !w.includes('límite de tokens') && !w.includes('truncada')) {
            userWarnings.push(w);
          }
        }
      } catch (err) {
        statusEl.textContent = `Error en fragmento ${i + 1}: ${err.message}`;
        statusEl.style.color = '#c00';
        hadError = true;
        break;
      }
    }

    if (!hadError) {
      candidates = merged;
      if (!candidates.length) {
        statusEl.textContent = 'No se encontraron tarjetas en el texto.';
        statusEl.style.color = '#b07d00';
      } else {
        statusEl.textContent = userWarnings.length ? `Advertencias: ${userWarnings.join(' | ')}` : '';
        statusEl.style.color = userWarnings.length ? '#b07d00' : '';
        renderCandidates();
        updateCount();
        candidatesWrap.classList.remove('hidden');
      }
    }

    extractBtn.disabled = false;
  });

  // Save selected
  saveBtn?.addEventListener('click', async () => {
    const toSave = candidates.filter(c => c._selected && c.status !== 'rejected');
    if (!toSave.length) {
      showToast('No hay tarjetas seleccionadas para guardar.', 'error');
      return;
    }

    const subject = document.querySelector('#ai-extract-subject')?.value?.trim() || null;

    saveBtn.disabled = true;

    try {
      const payload = {
        subject,
        cards: toSave.map(c => ({
          question: c.question,
          answer: c.answer,
          source_excerpt: c.source_excerpt,
          confidence: c.confidence,
          status: c.status,
        })),
      };

      const result = await postJson('/cards/import-reviewed', payload);
      showToast(`${result.inserted} tarjeta(s) guardada(s) correctamente.`, 'success');

      // Remove saved cards from the list
      const savedQuestions = new Set(toSave.map(c => c.question));
      candidates = candidates.filter(c => !savedQuestions.has(c.question));
      renderCandidates();
      updateCount();

      loadBrowserCards().catch(() => {});
      loadStudyOverview().catch(() => {});
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });
}

// ── Redundant card detection & merge ────────────────────────────────────────

function closeRedundantModal() {
  document.querySelector('#redundant-modal-overlay')?.classList.add('hidden');
}

document.querySelector('#redundant-modal-close')?.addEventListener('click', closeRedundantModal);
document.querySelector('#redundant-modal-overlay')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeRedundantModal();
});

async function openDetectRedundantModal() {
  const overlay  = document.querySelector('#redundant-modal-overlay');
  const intro    = document.querySelector('#redundant-modal-intro');
  const list     = document.querySelector('#redundant-clusters-list');
  const feedback = document.querySelector('#redundant-modal-feedback');
  const btn      = document.querySelector('#browser-detect-redundant-btn');

  overlay.classList.remove('hidden');
  list.innerHTML = '<div class="redundant-loading">Analizando tarjetas con IA… esto puede tardar unos segundos.</div>';
  intro.textContent = '';
  feedback.textContent = '';
  feedback.className = 'feedback';
  btn.disabled = true;

  const subjectFilter = document.querySelector('#browser-filter-subject')?.value.trim() || null;

  try {
    const data = await postJson('/cards/detect-redundant', subjectFilter ? { subject: subjectFilter } : {});
    const clusters = data?.clusters || [];

    if (!clusters.length) {
      intro.textContent = 'No se detectaron tarjetas redundantes' + (subjectFilter ? ` en "${subjectFilter}"` : '') + '.';
      list.innerHTML = '';
      return;
    }

    intro.textContent = `Se encontraron ${clusters.length} grupo(s) de tarjetas redundantes. Elegí cuál conservar como principal y mergeá el resto como variantes.`;
    list.innerHTML = clusters.map((cluster, ci) => renderClusterHTML(cluster, ci)).join('');

    list.querySelectorAll('.redundant-merge-btn').forEach((btn) => {
      btn.addEventListener('click', () => handleMergeCluster(btn, feedback));
    });
  } catch (err) {
    intro.textContent = '';
    list.innerHTML = '';
    showToast(`Error al detectar redundantes: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderClusterHTML(cluster, ci) {
  const cardsHTML = cluster.cards.map((card, i) => `
    <label class="redundant-card-option">
      <input type="radio" name="primary-${ci}" value="${card.id}" ${i === 0 ? 'checked' : ''}>
      <div class="redundant-card-body">
        <div class="redundant-card-subject">${escHtml(card.subject || '')}</div>
        <div class="redundant-card-prompt">${escHtml(card.prompt_text)}</div>
        <div class="redundant-card-answer-label">Respuesta esperada</div>
        <div class="redundant-card-answer">${escHtml(card.expected_answer_text)}</div>
      </div>
    </label>`).join('');

  const allIds = cluster.cards.map((c) => c.id).join(',');

  return `
    <div class="redundant-cluster" data-cluster="${ci}" data-all-ids="${allIds}">
      <div class="redundant-cluster-header">
        <span class="redundant-cluster-badge">Cluster ${ci + 1}</span>
        <span class="redundant-cluster-reason">${escHtml(cluster.reason)}</span>
      </div>
      <div class="redundant-cards-list">${cardsHTML}</div>
      <div class="redundant-cluster-footer">
        <button type="button" class="btn-primary redundant-merge-btn" data-cluster="${ci}">
          Mergear — conservar seleccionada como principal
        </button>
        <span class="redundant-merge-status"></span>
      </div>
    </div>`;
}

async function handleMergeCluster(btn, feedback) {
  const ci      = btn.dataset.cluster;
  const cluster = document.querySelector(`.redundant-cluster[data-cluster="${ci}"]`);
  const allIds  = cluster.dataset.allIds.split(',').map(Number);
  const primaryId = Number(cluster.querySelector(`input[name="primary-${ci}"]:checked`)?.value);
  const secondaryIds = allIds.filter((id) => id !== primaryId);
  const statusEl = cluster.querySelector('.redundant-merge-status');

  if (!primaryId || !secondaryIds.length) return;

  btn.disabled = true;
  statusEl.textContent = 'Mergeando…';
  statusEl.className = 'redundant-merge-status';

  try {
    const result = await postJson('/cards/merge-as-variants', {
      primary_card_id: primaryId,
      secondary_card_ids: secondaryIds
    });
    statusEl.textContent = `✓ ${result.merged} mergeada(s)`;
    statusEl.className = 'redundant-merge-status success';
    cluster.classList.add('redundant-cluster--done');
    showToast(`${result.merged} tarjeta(s) mergeadas como variante.`, 'success');
    loadBrowserCards().catch(() => {});
  } catch (err) {
    btn.disabled = false;
    statusEl.textContent = `Error`;
    statusEl.className = 'redundant-merge-status error';
    showToast(`Error al mergear: ${err.message}`, 'error');
  }
}

// --- Reformat LaTeX modal ---

function closeReformatModal() {
  document.querySelector('#reformat-modal-overlay')?.classList.add('hidden');
}

document.querySelector('#reformat-modal-close')?.addEventListener('click', closeReformatModal);
document.querySelector('#reformat-modal-cancel')?.addEventListener('click', closeReformatModal);
document.querySelector('#reformat-modal-overlay')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeReformatModal();
});

async function openReformatLatexModal() {
  const selectedIds = getSelectedCardIds();
  if (!selectedIds.length) {
    showToast('Seleccioná al menos una tarjeta para reformatear.', 'error');
    return;
  }
  if (selectedIds.length > 30) {
    showToast('Máximo 30 tarjetas por vez.', 'error');
    return;
  }

  const overlay    = document.querySelector('#reformat-modal-overlay');
  const resultList = document.querySelector('#reformat-results-list');
  const feedback   = document.querySelector('#reformat-modal-feedback');
  const saveBtn    = document.querySelector('#reformat-save-btn');
  const reformatBtn = document.querySelector('#browser-reformat-latex-btn');

  overlay.classList.remove('hidden');
  resultList.innerHTML = '<div style="color:var(--text-muted);padding:12px 0;font-size:0.88rem">Analizando con IA… esto puede tardar unos segundos.</div>';
  if (feedback) { feedback.textContent = ''; feedback.className = 'feedback'; }
  saveBtn.classList.add('hidden');
  reformatBtn.disabled = true;

  let results = [];

  try {
    const data = await postJson('/cards/reformat-prompt', { card_ids: selectedIds, save: false });
    results = data?.results || [];

    if (!results.length) {
      resultList.innerHTML = '<div style="color:var(--text-muted)">No se obtuvieron resultados.</div>';
      return;
    }

    resultList.innerHTML = results.map(r => {
      const changed = r.reformatted && r.reformatted !== r.original;
      const scoreHtml = r.score != null
        ? `<span style="font-size:0.78rem;color:var(--text-muted);margin-left:8px">Claridad: ${r.score}/10</span>`
        : '';
      const commentHtml = r.comment
        ? `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px;font-style:italic">${escHtml(r.comment)}</div>`
        : '';
      const changeTag = changed
        ? '<span style="font-size:0.75rem;background:var(--hl-green-bg,#d4edda);color:#155724;padding:1px 6px;border-radius:3px;margin-left:6px">modificada</span>'
        : '<span style="font-size:0.75rem;background:var(--bg-subtle);color:var(--text-muted);padding:1px 6px;border-radius:3px;margin-left:6px">sin cambios</span>';

      return `<div class="reformat-result-item" data-id="${r.id}" style="margin-bottom:16px;border:1px solid var(--border-mid);border-radius:6px;padding:12px">
        <div style="font-weight:600;font-size:0.84rem;margin-bottom:8px">Tarjeta #${r.id}${changeTag}${scoreHtml}</div>
        ${commentHtml}
        ${changed ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
          <div>
            <div style="font-size:0.75rem;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;letter-spacing:.04em">Original</div>
            <div style="font-size:0.84rem;background:var(--bg-subtle);padding:8px;border-radius:4px;white-space:pre-wrap">${escHtml(r.original)}</div>
          </div>
          <div>
            <div style="font-size:0.75rem;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;letter-spacing:.04em">Reformateado</div>
            <div class="reformat-preview-rendered" style="font-size:0.84rem;background:var(--bg-subtle);padding:8px;border-radius:4px">${formatPromptForDisplay(r.reformatted)}</div>
          </div>
        </div>` : `
        <div style="font-size:0.84rem;color:var(--text-muted);margin-top:4px">${escHtml(r.original)}</div>`}
      </div>`;
    }).join('');

    const hasChanges = results.some(r => r.reformatted && r.reformatted !== r.original);
    if (hasChanges) saveBtn.classList.remove('hidden');

  } catch (err) {
    resultList.innerHTML = '';
    showToast(`Error al reformatear: ${err.message}`, 'error');
  } finally {
    reformatBtn.disabled = false;
  }

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const idsToSave = results.filter(r => r.reformatted && r.reformatted !== r.original).map(r => r.id);
      await postJson('/cards/reformat-prompt', { card_ids: idsToSave, save: true });
      showToast(`${idsToSave.length} tarjeta(s) actualizadas. El texto original quedó en las notas.`, 'success');
      saveBtn.classList.add('hidden');
      loadBrowserCards().catch(() => {});
    } catch (err) {
      showToast(`Error al guardar: ${err.message}`, 'error');
      saveBtn.disabled = false;
    }
  };
}

function getSelectedCardIds() {
  return [...browserState.selected].filter(n => Number.isFinite(n) && n > 0);
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

function getDailyTarget()  { return parseInt(localStorage.getItem('discriminador_daily_target'))  || 50; }
function setDailyTarget(n) { localStorage.setItem('discriminador_daily_target', String(n)); }
function getDailyBudget()  { return parseInt(localStorage.getItem('discriminador_daily_budget'))  || 120; }
function setDailyBudget(n) { localStorage.setItem('discriminador_daily_budget', String(n)); }

async function loadDashboard() {
  const loading = document.querySelector('#dashboard-loading');
  const content = document.querySelector('#dashboard-content');
  const agendaContainer = document.querySelector('#dashboard-agenda');

  loading.classList.remove('hidden');
  content.innerHTML = '';
  if (agendaContainer) agendaContainer.innerHTML = '';

  try {
    const [overview, dueCounts, calendarData, agendaData] = await Promise.all([
      getJson('/stats/overview').catch(() => ({ subjects: [] })),
      getJson('/scheduler/due-counts').catch(() => ({ cards: {}, micros: {} })),
      getJson('/exam-calendar').catch(() => ({ exams: [] })),
      getJson('/scheduler/agenda').catch(() => null),
    ]);

    loading.classList.add('hidden');

    const normalizeSubject = (subject) => {
      const normalized = typeof subject === 'string' ? subject.trim() : '';
      return normalized || '(sin materia)';
    };

    const subjects = (overview.subjects || []).map((subj) => ({
      ...subj,
      subject: normalizeSubject(subj.subject),
    }));

    if (!subjects.length) {
      const card = document.createElement('div');
      card.className = 'onboarding-card card';
      card.innerHTML = `
        <div class="onboarding-header">
          <div class="onboarding-icon">◈</div>
          <div>
            <h2 class="onboarding-title">Bienvenido a Discriminador</h2>
            <p class="onboarding-subtitle">Tu sistema de repaso con IA para preparar exámenes. Seguí estos pasos para empezar.</p>
          </div>
        </div>
        <ol class="onboarding-steps">
          <li class="onboarding-step">
            <span class="onboarding-step-num">1</span>
            <div>
              <strong>Agregá tu primera tarjeta</strong>
              <p>Andá a la pestaña <em>Tarjetas</em> y creá una pregunta con su respuesta esperada.</p>
            </div>
          </li>
          <li class="onboarding-step">
            <span class="onboarding-step-num">2</span>
            <div>
              <strong>Configurá tu materia</strong>
              <p>Desde el Inicio, hacé clic en <em>Configurar</em> para establecer fechas de examen y nivel de exigencia.</p>
            </div>
          </li>
          <li class="onboarding-step">
            <span class="onboarding-step-num">3</span>
            <div>
              <strong>Empezá a estudiar</strong>
              <p>Andá a <em>Estudiar</em>, elegí cuánto tiempo tenés y la IA armará tu sesión de repaso.</p>
            </div>
          </li>
        </ol>
        <button type="button" class="btn-primary onboarding-cta" id="onboarding-goto-cards">Ir a Tarjetas →</button>
      `;
      content.appendChild(card);
      card.querySelector('#onboarding-goto-cards').addEventListener('click', () => {
        document.querySelector('[data-tab="browser"]').click();
      });
      return;
    }

    const pendingCardsBySubject = dueCounts.cards  || {};
    const activeMicrosBySubject = dueCounts.micros || {};
    const totalPendingCards = Object.values(pendingCardsBySubject).reduce((a, b) => a + b, 0);
    const totalActiveMicros = Object.values(activeMicrosBySubject).reduce((a, b) => a + b, 0);
    const totalDue = totalPendingCards + totalActiveMicros;

    const parseDashExamDate = (raw) => {
      const s = String(raw).slice(0, 10);
      const [y, m, d] = s.split('-').map(Number);
      return new Date(y, m - 1, d);
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // All future exams sorted ascending
    const allFutureExams = (calendarData?.exams || [])
      .map((e) => {
        const d = parseDashExamDate(e.exam_date);
        const days = Math.round((d - today) / 86400000);
        const weekday = d.toLocaleDateString('es-AR', { weekday: 'short' });
        const dateStr  = d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
        return { ...e, days, dateLabel: `${weekday} ${dateStr}`, readiness: (Number(e.scope_pct) || 0) / 100 };
      })
      .filter((e) => e.days > 0)
      .sort((a, b) => a.days - b.days);

    // Map each subject to its soonest upcoming exam
    const examBySubject = {};
    for (const exam of allFutureExams) {
      const subj = normalizeSubject(exam.subject);
      if (!examBySubject[subj]) examBySubject[subj] = exam;
    }

    // Subject list sorted by pending desc then alpha
    const subjectNames = [...new Set([
      ...subjects.map((s) => s.subject),
      ...Object.keys(pendingCardsBySubject),
      ...Object.keys(activeMicrosBySubject),
    ])].sort((a, b) => {
      const pa = pendingCardsBySubject[a] || 0;
      const pb = pendingCardsBySubject[b] || 0;
      return pb - pa || a.localeCompare(b, 'es');
    });

    const totalSubjects = subjectNames.length;
    const totalPendingAll = subjectNames.reduce((sum, n) => sum + (pendingCardsBySubject[n] || 0), 0);

    // ── 1. Headline ──────────────────────────────────────────────────────────
    {
      const el = document.createElement('h1');
      el.className = 'dsh-headline';
      if (totalDue > 0) {
        el.innerHTML = `${totalDue} pendientes hoy <span class="dsh-headline-sub">(${totalPendingCards} tarjetas principales + ${totalActiveMicros} microconsignas).</span>`;
      } else {
        el.textContent = 'Sin pendientes hoy.';
      }
      content.appendChild(el);
    }

    // ── 2. Próximos exámenes (top 5, future only) ────────────────────────────
    const topExams = allFutureExams.slice(0, 5);
    if (topExams.length > 0) {
      const card = document.createElement('div');
      card.className = 'dsh-card dsh-exam-strip';

      const rows = topExams.map((e, i) => {
        const rPct = Math.round(e.readiness * 100);
        const rCls = e.readiness >= 0.4 ? 'good' : e.readiness >= 0.2 ? 'amber' : 'bad';
        return `
          <div class="dsh-exam-row${i > 0 ? ' dsh-row-border' : ''}">
            <span class="dsh-exam-days">${e.days}d</span>
            <span class="dsh-exam-name">${escHtml(e.subject)}${e.label ? ' · ' + escHtml(e.label) : ''}</span>
            <span class="dsh-exam-date">${e.dateLabel}</span>
            <div class="dsh-readiness-wrap">
              <div class="dsh-readiness-track">
                <div class="dsh-readiness-fill dsh-r-${rCls}" style="width:${rPct}%"></div>
              </div>
              <span class="dsh-readiness-pct">${rPct}%</span>
            </div>
          </div>`;
      }).join('');

      card.innerHTML = `
        <div class="dsh-card-header">
          <span>
            <span class="dsh-card-title">Próximos exámenes</span>
            <span class="dsh-card-meta"> · siguiente en ${topExams[0].days} días</span>
          </span>
          <span class="dsh-card-link dsh-exam-ver-todos">ver todos →</span>
        </div>
        ${rows}`;

      card.querySelector('.dsh-exam-ver-todos').addEventListener('click', () => {
        document.querySelector('[data-tab="planner"]')?.click();
      });
      content.appendChild(card);
    }

    // ── 3. Materias ───────────────────────────────────────────────────────────
    {
      const card = document.createElement('div');
      card.className = 'dsh-card dsh-materias-card';

      const rows = subjectNames.map((name, i) => {
        const pend    = pendingCardsBySubject[name] || 0;
        const hasPend = pend > 0;
        const exam    = examBySubject[name];
        const r       = exam ? exam.readiness : null;
        const rPct    = r !== null ? Math.round(r * 100) : null;
        const rCls    = r !== null ? (r >= 0.4 ? 'good' : r >= 0.2 ? 'amber' : 'bad') : '';

        const examCell = exam
          ? `${escHtml(exam.label || '')} <span class="dsh-exam-days-sm">en ${exam.days}d</span>`
          : `<span class="dsh-cell-empty">—</span>`;

        const readinessCell = r !== null
          ? `<div class="dsh-readiness-wrap">
               <div class="dsh-readiness-track dsh-track-sm">
                 <div class="dsh-readiness-fill dsh-r-${rCls}" style="width:${rPct}%"></div>
               </div>
               <span class="dsh-readiness-pct">${rPct}%</span>
             </div>`
          : `<span class="dsh-cell-empty">—</span>`;

        return `
          <div class="dsh-mat-row${i > 0 ? ' dsh-row-border' : ''}">
            <span class="dsh-mat-pend ${hasPend ? 'pend-has' : 'pend-zero'}">${hasPend ? pend : '·'}</span>
            <span class="dsh-mat-name ${hasPend ? 'name-active' : 'name-dim'}">${escHtml(name)}</span>
            <span class="dsh-mat-event">${examCell}</span>
            <span class="dsh-mat-readiness">${readinessCell}</span>
            <div class="dsh-mat-actions">
              <button type="button" class="${hasPend ? 'dsh-btn-study-primary' : 'dsh-btn-study-secondary'} deck-study-btn" data-subject="${escHtml(name)}">Estudiar</button>
              <button type="button" class="dsh-btn-icon deck-config-btn" data-subject="${escHtml(name)}" title="Configurar">⚙</button>
              <button type="button" class="dsh-btn-icon deck-rename-btn" data-subject="${escHtml(name)}" title="Renombrar">✎</button>
            </div>
          </div>`;
      }).join('');

      card.innerHTML = `
        <div class="dsh-card-header">
          <span>
            <span class="dsh-card-title">Materias</span>
            <span class="dsh-card-meta"> (${totalSubjects} · ${totalPendingAll} pendientes)</span>
          </span>
          <div class="dsh-card-header-right">
            <span class="dsh-card-meta">orden: pendientes ↓</span>
            <span class="dsh-card-link dsh-btn-new-subject">+ nueva</span>
          </div>
        </div>
        <div class="dsh-mat-colhead">
          <span class="dsh-col-pend">pend.</span>
          <span>materia</span>
          <span>próximo evento</span>
          <span>preparación</span>
          <span class="dsh-col-actions">acciones</span>
        </div>
        ${rows}`;

      card.querySelector('.dsh-btn-new-subject').addEventListener('click', () => {
        document.querySelector('[data-tab="browser"]')?.click();
      });

      card.addEventListener('click', async (e) => {
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
            else showToast('No se encontraron tarjetas para renombrar.', 'error');
          } catch (err) {
            showToast(`Error al renombrar: ${err.message}`, 'error');
          }
        }
      });

      content.appendChild(card);
    }

    // ── 4. Agenda (collapsible, collapsed by default) ─────────────────────────
    if (agendaData) {
      const s = agendaData.summary || {};
      const buckets = agendaData.buckets ?? {};
      const totalCards = Object.values(buckets).reduce((n, arr) => n + arr.length, 0);

      if (totalCards > 0) {
        const card = document.createElement('div');
        card.className = 'dsh-card dsh-agenda-card';

        const badgesHtml = [
          s.overdue      ? `<span class="dsh-badge dsh-badge-bad">${s.overdue} vencida${s.overdue !== 1 ? 's' : ''}</span>` : '',
          s.due_tomorrow ? `<span class="dsh-badge dsh-badge-amber">${s.due_tomorrow} mañana</span>` : '',
          s.total_cards  ? `<span class="dsh-badge dsh-badge-neutral">${s.total_cards} total</span>` : '',
        ].join('');

        const header = document.createElement('div');
        header.className = 'dsh-agenda-header';
        header.innerHTML = `
          <div class="dsh-agenda-badges">
            <span class="dsh-card-title">Agenda</span>
            ${badgesHtml}
          </div>
          <span class="dsh-agenda-chevron">⌄</span>`;
        card.appendChild(header);

        const body = document.createElement('div');
        body.className = 'dsh-agenda-body';
        body.style.display = 'none';

        // Collect up to 10 preview cards across all buckets
        const previewCards = [];
        for (const key of Object.keys(BUCKET_LABELS)) {
          for (const c of (buckets[key] ?? [])) {
            previewCards.push(c);
            if (previewCards.length >= 10) break;
          }
          if (previewCards.length >= 10) break;
        }

        previewCards.forEach((c, i) => {
          const dueDate = new Date(c.next_review_at);
          const dueStr = formatDue(dueDate);
          const item = document.createElement('div');
          item.className = `dsh-agenda-item${i > 0 ? ' dsh-row-border' : ''}`;
          item.innerHTML = `
            <div class="dsh-agenda-item-meta">
              ${c.subject ? `<span class="dsh-agenda-badge">${escHtml(c.subject)}</span>` : ''}
              <span class="dsh-agenda-ago">${dueStr}</span>
              <span class="dsh-agenda-stats">${c.review_count} revis. · ${c.pass_count} ok</span>
            </div>
            <div class="dsh-agenda-item-text">${escHtml(truncate(c.prompt_text, 100))}</div>`;
          body.appendChild(item);
        });

        if (totalCards > previewCards.length) {
          const more = document.createElement('div');
          more.className = 'dsh-agenda-more';
          more.textContent = `ver las ${totalCards - previewCards.length} restantes →`;
          more.addEventListener('click', () => {
            document.querySelector('[data-tab="study"]')?.click();
          });
          body.appendChild(more);
        }

        card.appendChild(body);

        let expanded = false;
        header.addEventListener('click', () => {
          expanded = !expanded;
          body.style.display = expanded ? 'block' : 'none';
          header.querySelector('.dsh-agenda-chevron').textContent = expanded ? '⌃' : '⌄';
        });

        content.appendChild(card);
      }
    }

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

// --- Weekly stats rendering ---

const MANUAL_TYPE_LABELS_WEEKLY = {
  clase:           'Clase',
  contenido:       'Contenido',
  estudio_offline: 'Estudio offline',
  reunion:         'Reunión',
  otro:            'Otro',
};

function fmtMinutes(m) {
  if (!m || m <= 0) return '0m';
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}m`;
  if (min === 0) return `${h}h`;
  return `${h}h ${min}m`;
}

function renderWeeklyStats(data) {
  const pillsEl    = document.querySelector('#progress-weekly-pills');
  const daysEl     = document.querySelector('#progress-weekly-days');
  const chartEl    = document.querySelector('#progress-weekly-chart');
  const subjectsEl = document.querySelector('#progress-weekly-subjects');
  const manualEl   = document.querySelector('#progress-weekly-manual');
  if (!pillsEl) return;

  if (!data) {
    pillsEl.innerHTML = '<span style="color:var(--text-muted);font-size:var(--fs-sm)">No hay datos disponibles.</span>';
    daysEl.innerHTML = chartEl.innerHTML = subjectsEl.innerHTML = manualEl.innerHTML = '';
    return;
  }

  const tw = data.this_week || {};

  // ── Summary pills ──────────────────────────────────────────────────────────
  pillsEl.innerHTML = '';
  [
    { val: fmtMinutes(tw.study_minutes),  label: 'Repaso',      cls: 'pw-pill--study' },
    { val: fmtMinutes(tw.manual_minutes), label: 'Manual',      cls: 'pw-pill--manual' },
    { val: tw.review_count ?? 0,          label: 'Revisiones',  cls: '' },
  ].forEach(({ val, label, cls }) => {
    const p = document.createElement('div');
    p.className = `progress-pill pw-pill ${cls}`;
    p.innerHTML = `<span class="progress-pill-num">${val}</span><span class="progress-pill-label">${label}</span>`;
    pillsEl.appendChild(p);
  });

  // ── Active days chips (rolling 7-day window) ──────────────────────────────
  daysEl.innerHTML = '';
  const activeDates = new Set(tw.active_dates || []);
  const periodStartDate = new Date((tw.period_start || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  const DAY_LABELS_BY_DOW = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(periodStartDate);
    d.setUTCDate(d.getUTCDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const active = activeDates.has(ds);
    const chip = document.createElement('div');
    chip.className = `pw-day-chip${active ? ' pw-day-chip--active' : ''}`;
    chip.title = ds;
    chip.innerHTML = `<span>${DAY_LABELS_BY_DOW[d.getUTCDay()]}</span>`;
    daysEl.appendChild(chip);
  }

  // ── 8-week bar chart (SVG) ─────────────────────────────────────────────────
  chartEl.innerHTML = '';
  const weeks = data.last_8_weeks || [];
  if (weeks.length > 0) {
    const label = document.createElement('p');
    label.className = 'pw-chart-label';
    label.textContent = 'Últimas 8 semanas';
    chartEl.appendChild(label);

    const maxMin = Math.max(...weeks.map(w => w.total_minutes), 1);
    const BAR_W = 28;
    const GAP   = 6;
    const H     = 80;
    const svgW  = weeks.length * (BAR_W + GAP) - GAP;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${svgW} ${H + 24}`);
    svg.setAttribute('width', '100%');
    svg.style.maxWidth = `${svgW * 2}px`;
    svg.style.display = 'block';

    weeks.forEach((w, i) => {
      const x = i * (BAR_W + GAP);
      const studyH  = Math.round((w.study_minutes  / maxMin) * H);
      const manualH = Math.round((w.manual_minutes / maxMin) * H);
      const totalH  = Math.min(H, studyH + manualH);
      const isThisWeek = i === weeks.length - 1;

      // Manual portion (bottom)
      if (manualH > 0) {
        const r1 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r1.setAttribute('x', x);
        r1.setAttribute('y', H - Math.min(manualH, H));
        r1.setAttribute('width', BAR_W);
        r1.setAttribute('height', Math.min(manualH, H));
        r1.setAttribute('rx', '3');
        r1.setAttribute('fill', isThisWeek ? 'var(--c-warn)' : 'rgba(201,132,40,0.45)');
        svg.appendChild(r1);
      }

      // Study portion (stacked on top of manual)
      if (studyH > 0) {
        const studyY = H - totalH;
        const r2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r2.setAttribute('x', x);
        r2.setAttribute('y', studyY);
        r2.setAttribute('width', BAR_W);
        r2.setAttribute('height', studyH);
        r2.setAttribute('rx', '3');
        r2.setAttribute('fill', isThisWeek ? 'var(--c-ok)' : 'rgba(78,136,160,0.55)');
        svg.appendChild(r2);
      }

      // Week label (short date)
      const dateLabel = w.week_start ? w.week_start.slice(5).replace('-', '/') : '';
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', x + BAR_W / 2);
      t.setAttribute('y', H + 16);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', '9');
      t.setAttribute('fill', isThisWeek ? 'var(--text)' : 'var(--text-muted)');
      t.setAttribute('font-weight', isThisWeek ? '600' : '400');
      t.textContent = dateLabel;
      svg.appendChild(t);

      // Tooltip title on the SVG group
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${w.week_start}: ${fmtMinutes(w.study_minutes)} repaso + ${fmtMinutes(w.manual_minutes)} manual`;
      svg.appendChild(title);
    });

    // Legend
    const legend = document.createElement('div');
    legend.className = 'pw-chart-legend';
    legend.innerHTML = `
      <span class="pw-legend-dot pw-legend-dot--study"></span><span>Repaso</span>
      <span class="pw-legend-dot pw-legend-dot--manual"></span><span>Manual</span>
    `;
    chartEl.appendChild(svg);
    chartEl.appendChild(legend);
  }

  // ── Per-subject horizontal bars ────────────────────────────────────────────
  subjectsEl.innerHTML = '';
  const subjects = tw.by_subject || [];
  if (subjects.length > 0) {
    const label2 = document.createElement('p');
    label2.className = 'pw-chart-label';
    label2.textContent = 'Por materia (últimos 7 días)';
    subjectsEl.appendChild(label2);

    const maxSubMin = Math.max(...subjects.map(s => s.total_minutes), 1);
    subjects.slice(0, 8).forEach(s => {
      const pct = Math.round((s.total_minutes / maxSubMin) * 100);
      const row = document.createElement('div');
      row.className = 'pw-subj-row';
      const studyPct  = Math.round((s.study_minutes  / maxSubMin) * 100);
      const manualPct = Math.round((s.manual_minutes / maxSubMin) * 100);
      row.innerHTML = `
        <span class="pw-subj-name">${s.subject}</span>
        <div class="pw-subj-track">
          <div class="pw-subj-fill pw-subj-fill--study"  style="left:0;width:${studyPct}%"></div>
          <div class="pw-subj-fill pw-subj-fill--manual" style="left:${studyPct}%;width:${manualPct}%"></div>
        </div>
        <span class="pw-subj-total">${fmtMinutes(s.total_minutes)}</span>
      `;
      subjectsEl.appendChild(row);
    });
  }

  // ── Manual activity type chips ─────────────────────────────────────────────
  manualEl.innerHTML = '';
  const types = tw.by_manual_type || [];
  if (types.length > 0) {
    const label3 = document.createElement('p');
    label3.className = 'pw-chart-label';
    label3.textContent = 'Actividad manual';
    manualEl.appendChild(label3);

    const chips = document.createElement('div');
    chips.className = 'pw-type-chips';
    types.forEach(t => {
      const chip = document.createElement('div');
      chip.className = `pw-type-chip pw-type-chip--${t.activity_type}`;
      chip.textContent = `${MANUAL_TYPE_LABELS_WEEKLY[t.activity_type] || t.activity_type}  ${fmtMinutes(t.minutes)}`;
      chips.appendChild(chip);
    });
    manualEl.appendChild(chips);
  }
}

// --- Progress tab ---

async function loadProgress() {
  const loading = document.querySelector('#progress-loading');
  const content = document.querySelector('#progress-content');
  loading.classList.remove('hidden');
  content.classList.add('hidden');

  try {
    const [actData, overview, timingData, logsData, weeklyData] = await Promise.all([
      getJson('/stats/activity?days=3650'),
      getJson('/stats/overview').catch(() => ({ subjects: [] })),
      getJson('/stats/timing?weeks=4').catch(() => null),
      getJson('/session/plan-logs?limit=10').catch(() => ({ logs: [] })),
      getJson('/stats/weekly').catch(() => null),
    ]);

    loading.classList.add('hidden');
    content.classList.remove('hidden');

    // Weekly stats section
    renderWeeklyStats(weeklyData);

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
    renderPlanLogs(logsData?.logs || []);
  } catch (err) {
    loading.classList.add('hidden');
    document.querySelector('#progress-content').innerHTML =
      `<p style="color:var(--fail-fg);padding:16px">Error al cargar progreso: ${err.message}</p>`;
    document.querySelector('#progress-content').classList.remove('hidden');
  }
}

function renderPlanLogs(logs) {
  const el = document.querySelector('#progress-plan-logs');
  if (!el) return;

  if (!logs.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:var(--fs-sm)">Aún no hay sesiones planificadas por el agente.</p>';
    return;
  }

  el.innerHTML = '';
  for (const log of logs) {
    const date = new Date(log.created_at).toLocaleString('es-AR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    const forcedBadge = log.forced_count > 0
      ? `<span class="plan-log-forced-badge">${log.forced_count} forzada${log.forced_count !== 1 ? 's' : ''}</span>`
      : '';

    const entry = document.createElement('div');
    entry.className = 'plan-log-entry';
    entry.innerHTML = `
      <div class="plan-log-header">
        <span class="plan-log-date">${date}</span>
        <span class="plan-log-stats">${log.planned_count} incluidas · ${log.deferred_count} diferidas ${forcedBadge}</span>
        <button class="btn-ghost plan-log-toggle" type="button">Ver ▾</button>
      </div>
      <div class="plan-log-body hidden">${log.agent_reasoning || '(sin razonamiento)'}</div>
    `;
    entry.querySelector('.plan-log-toggle').addEventListener('click', (e) => {
      const body    = entry.querySelector('.plan-log-body');
      const isHidden = body.classList.toggle('hidden');
      e.target.textContent = isHidden ? 'Ver ▾' : 'Ocultar ▴';
    });
    el.appendChild(entry);
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
const _evalHlColorSelect  = document.querySelector('#eval-hl-color');
const _studyHlColorSelect = document.querySelector('#study-hl-color');
const HL_COLOR_STORAGE_KEY = 'math-hl-color';

function getMathHighlightColor() {
  const saved = localStorage.getItem(HL_COLOR_STORAGE_KEY) || 'yellow';
  return ['yellow', 'blue', 'green', 'pink'].includes(saved) ? saved : 'yellow';
}

function setMathHighlightColor(color) {
  const safe = ['yellow', 'blue', 'green', 'pink'].includes(color) ? color : 'yellow';
  localStorage.setItem(HL_COLOR_STORAGE_KEY, safe);
  if (_evalHlColorSelect) _evalHlColorSelect.value = safe;
  if (_studyHlColorSelect) _studyHlColorSelect.value = safe;
  MathPreview.setHighlightColor(_evalAnswerTextarea, safe);
  MathPreview.setHighlightColor(document.querySelector('#study-answer-input'), safe);
}

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
setMathHighlightColor(getMathHighlightColor());
_evalHlColorSelect?.addEventListener('change', (e) => setMathHighlightColor(e.target.value));
_studyHlColorSelect?.addEventListener('change', (e) => setMathHighlightColor(e.target.value));

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
  prompt_text: 1,
  user_answer_text: 1,
  expected_answer_text: 1,
};

const errorMessages = {
  prompt_text: 'La consigna es obligatoria.',
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

function showToast(message, type = 'info', duration) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const ms = duration ?? (type === 'error' ? 5000 : 3200);
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML =
    `<i class="toast-icon">${icons[type] ?? icons.info}</i>` +
    `<span class="toast-msg">${message}</span>` +
    `<button class="toast-close" aria-label="Cerrar">×</button>`;
  const dismiss = () => {
    if (!toast.isConnected) return;
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };
  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  container.appendChild(toast);
  const timer = setTimeout(dismiss, ms);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => setTimeout(dismiss, 1200));
}

function setFeedback(message, type = '') {
  if (!message) return;
  if (type === 'success' || type === 'error') {
    showToast(message, type);
  } else {
    showToast(message, 'info');
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
const LATEX_DELIM_RE = /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/;

// Renders a single line of text replacing $...$ (inline) and $$...$$ (display) with KaTeX HTML.
function renderKaTeXInline(line) {
  if (typeof window.katex === 'undefined') return escHtml(line);
  const result = [];
  let lastIndex = 0;
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    if (match.index > lastIndex) result.push(escHtml(line.slice(lastIndex, match.index)));
    const isDisplay = match[1] !== undefined;
    const mathContent = isDisplay ? match[1] : match[2];
    try {
      result.push(window.katex.renderToString(mathContent, { displayMode: isDisplay, throwOnError: false, output: 'html' }));
    } catch (_) {
      result.push(escHtml(match[0]));
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < line.length) result.push(escHtml(line.slice(lastIndex)));
  return result.join('');
}

// Renders fenced ``` blocks and inline `code` in arbitrary text → safe HTML.
function renderCodeMarkdown(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');

  // 1. Fenced code blocks (``` ... ```)
  const parts = normalized.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      // Inside a fenced block
      const inner = part.slice(3, -3).replace(/^\n/, '').replace(/\n$/, '');
      return `<pre class="card-code-block"><code>${escHtml(inner)}</code></pre>`;
    }
    // Outside: handle inline `code` and preserve newlines
    return part
      .split(/(`[^`\n]+`)/g)
      .map((s, j) => {
        if (j % 2 === 1) return `<code class="card-code-inline">${escHtml(s.slice(1, -1))}</code>`;
        return escHtml(s).replace(/\n/g, '<br>');
      })
      .join('');
  }).join('');
}

function formatPromptForDisplay(text) {
  const normalized = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/:\s+([•●▪◦])/g, ':\n$1')
    .replace(/\s+([•●▪◦])\s+/g, '\n$1 ')
    .trim();

  // If text has code blocks/inline code, delegate to the markdown renderer.
  if (/```|`[^`]/.test(normalized)) {
    return renderCodeMarkdown(normalized);
  }

  // If text has LaTeX delimiters ($...$  or  $$...$$), render with KaTeX.
  if (LATEX_DELIM_RE.test(normalized) && typeof window.katex !== 'undefined') {
    return normalized.split('\n').map(line => {
      if (!line.trim()) return '<br>';
      return renderKaTeXInline(line) + '<br>';
    }).join('');
  }

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
    || /[{}]/.test(text)                                        // curly braces → code
    || (text.match(/;/g) || []).length >= 2                     // 2+ semicolons → code (single ; is common prose)
    || /(^|\n)\s{2,}\S/.test(text);
}

function formatAnswerBlock(label, text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const hasMarkdownCode = /```|`[^`]/.test(raw);
  if (hasMarkdownCode) {
    return `<div class="study-answer-compare-block"><strong>${label}:</strong><div class="study-answer-compare-text">${renderCodeMarkdown(raw)}</div></div>`;
  }
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

// ── Chinese TTS helpers ───────────────────────────────────────────────────────

/** Returns true if text contains CJK Unified Ideographs (Hanzi). */
function hasChinese(text) {
  return /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/u.test(text || '');
}

let _ttsAudio = null;                    // keep reference to stop previous playback
let _ttsCurrentText = null;             // Hanzi text for the post-eval TTS bar
let _ttsListeningText = null;           // Hanzi text for the listening variant prompt bar
const _ttsCache   = new Map();           // text → base64 audio string (session cache)
let _voiceFrontAudio = null;
let _voiceEpoch = 0;                     // incremented each showStudyCard() call to cancel stale playback
const _pinyinCache = new Map();          // text → pinyin string (session cache)

/**
 * Plays the TTS audio for the given Hanzi text.
 * Fetches from POST /tts on first use; subsequent calls use the in-memory cache.
 * If autoplay is blocked by the browser, the button stays enabled for manual replay.
 * btnSelector defaults to the post-eval replay button; pass a different selector for other contexts.
 */
async function playChineseTTS(text, btnSelector = '#study-tts-btn') {
  const btn = document.querySelector(btnSelector);
  if (!text || !hasChinese(text)) return;

  // Stop any currently playing audio
  if (_ttsAudio) {
    _ttsAudio.pause();
    _ttsAudio = null;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = _ttsCache.has(text) ? '🔊 Cargando...' : '⏳ Cargando...';
  }

  try {
    let audioB64 = _ttsCache.get(text);
    if (!audioB64) {
      const data = await postJson('/tts', { text });
      if (!data?.audio) throw new Error('Sin audio en la respuesta');
      audioB64 = data.audio;
      _ttsCache.set(text, audioB64);
      if (data.pinyin) _pinyinCache.set(text, data.pinyin);
    }

    const byteChars = atob(audioB64);
    const byteArr = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
    const blob = new Blob([byteArr], { type: 'audio/mpeg' });
    const url  = URL.createObjectURL(blob);

    _ttsAudio = new Audio(url);
    _ttsAudio.onended = () => {
      URL.revokeObjectURL(url);
      if (btn) { btn.disabled = false; btn.textContent = '🔊 Escuchar'; }
    };
    _ttsAudio.onerror = () => {
      if (btn) { btn.disabled = false; btn.textContent = '🔊 Escuchar'; }
    };

    if (btn) btn.textContent = '🔊 Reproduciendo...';

    // play() returns a Promise — catch rejection so autoplay block doesn't silence everything
    _ttsAudio.play().catch(() => {
      // Autoplay blocked or load error: re-enable button so user can tap manually
      if (btn) { btn.disabled = false; btn.textContent = '🔊 Escuchar'; }
    });
  } catch (err) {
    console.error('TTS error:', err.message);
    if (btn) { btn.disabled = false; btn.textContent = '🔊 Escuchar'; }
  }
}

/**
 * Returns the pinyin for a Hanzi string, fetching from /tts if not cached.
 * Reuses the same session cache as playChineseTTS so there is at most one
 * network call per unique text regardless of call order.
 */
async function fetchPinyin(text) {
  if (!text || !hasChinese(text)) return '';
  if (_pinyinCache.has(text)) return _pinyinCache.get(text);
  try {
    const data = await postJson('/tts', { text });
    if (data?.audio) _ttsCache.set(text, data.audio);
    const py = data?.pinyin || '';
    _pinyinCache.set(text, py);
    return py;
  } catch {
    return '';
  }
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
    user_answer_text: normalize(MathPreview.serialize(form.user_answer_text)),
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
function attachDictation(btn, textarea, labelIdle = 'Dictar', subjectOverride = null, onTranscribed = null) {
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
          const mathEditor = textarea._mathEditorEl;
          const isMathActive = mathEditor && !mathEditor.classList.contains('hidden');
          if (isMathActive) {
            // In math mode the textarea is hidden — insert into the contenteditable.
            // execCommand fires the editor's input→sync chain automatically.
            mathEditor.focus();
            const needsSpace = mathEditor.textContent.length > 0 && !mathEditor.textContent.endsWith(' ');
            document.execCommand('insertText', false, (needsSpace ? ' ' : '') + text);
          } else {
            const current = textarea.value;
            const separator = current && !current.endsWith(' ') ? ' ' : '';
            textarea.value = current + separator + text;
            // Dispatch input so SqlEditor gutter and any other listeners update.
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
          if (text && typeof onTranscribed === 'function') onTranscribed();
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

  try {
    await postJson(DECISION_ENDPOINT, decisionPayload);
    removeManualCase(uiState.lastResult?.evaluation_id);
    loadSubjects();
    resetForm();
    showToast('Decisión guardada. Podés continuar con la siguiente.', 'success');
  } catch (error) {
    showToast(`Error al guardar la decisión: ${error.message}`, 'error');
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
      sessionPausedMs: studyState.sessionPausedMs ?? 0,
      lastBreakNudgeMinuteKey: studyState.lastBreakNudgeMinuteKey ?? null,
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
    studyState.sessionPausedMs    = Number(saved.sessionPausedMs) || 0;
    studyState.lastBreakNudgeMinuteKey = saved.lastBreakNudgeMinuteKey || null;
    studyState.isPaused = false;
    studyState.pausedAt = 0;
    studyState.cardPausedMs = 0;

    document.querySelector('#study-briefing').classList.add('hidden');
    document.querySelector('#study-overview').classList.add('hidden');
    document.querySelector('#study-complete').classList.add('hidden');
    document.querySelector('#study-session').classList.remove('hidden');
    startStudyRealtimeScheduler();
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
  if (userSettings.session_planning_enabled) {
    document.querySelector('#study-briefing').classList.remove('hidden');
    document.querySelector('#study-overview').classList.add('hidden');
  } else {
    document.querySelector('#study-briefing').classList.add('hidden');
    document.querySelector('#study-overview').classList.remove('hidden');
    loadStudyOverview();
  }

  ensureAddCardFormHandlers();
  document.querySelector('#study-overview-back-btn').addEventListener('click', () => {
    document.querySelector('#study-overview').classList.add('hidden');
    document.querySelector('#study-briefing').classList.remove('hidden');
  });

  // ── Exam simulation modal ────────────────────────────────────────────────
  let _examSelectedCount = 10;

  function openExamModal() {
    const input = document.querySelector('#exam-sim-subject-input');
    if (briefingState.selectedSubject) input.value = briefingState.selectedSubject;
    document.querySelector('#exam-sim-feedback').classList.add('hidden');
    // Reset focus panel to collapsed state each time the modal opens
    document.querySelector('#exam-focus-panel').classList.add('hidden');
    document.querySelector('#exam-focus-toggle').textContent = '+ Enfocar en temas específicos del examen';
    document.querySelector('#exam-focus-input').value = '';
    document.querySelector('#exam-sim-modal').classList.remove('hidden');
    input.focus();
  }
  function closeExamModal() {
    document.querySelector('#exam-sim-modal').classList.add('hidden');
  }

  document.querySelector('#exam-sim-open-btn').addEventListener('click', openExamModal);
  document.querySelector('#exam-sim-close-btn').addEventListener('click', closeExamModal);
  document.querySelector('#exam-sim-cancel-btn').addEventListener('click', closeExamModal);
  document.querySelector('.exam-sim-backdrop').addEventListener('click', closeExamModal);

  document.querySelector('#exam-focus-toggle').addEventListener('click', () => {
    const panel = document.querySelector('#exam-focus-panel');
    const toggle = document.querySelector('#exam-focus-toggle');
    const isHidden = panel.classList.toggle('hidden');
    toggle.textContent = isHidden
      ? '+ Enfocar en temas específicos del examen'
      : '− Enfocar en temas específicos del examen';
    if (!isHidden) document.querySelector('#exam-focus-input').focus();
  });

  document.querySelectorAll('.exam-count-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.exam-count-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      _examSelectedCount = parseInt(pill.dataset.count, 10);
    });
  });

  document.querySelector('#exam-sim-start-btn').addEventListener('click', async () => {
    const subject = (document.querySelector('#exam-sim-subject-input').value || '').trim();
    const fb = document.querySelector('#exam-sim-feedback');
    if (!subject) {
      fb.textContent = 'Elegí una materia para el simulacro.';
      fb.classList.remove('hidden');
      return;
    }
    const examFocusPrompt = (document.querySelector('#exam-focus-input').value || '').trim();
    const startBtn = document.querySelector('#exam-sim-start-btn');
    startBtn.disabled = true;
    startBtn.textContent = examFocusPrompt ? 'Analizando temas...' : 'Cargando...';
    fb.classList.add('hidden');
    try {
      const payload = { subject, count: _examSelectedCount };
      if (examFocusPrompt) payload.examFocusPrompt = examFocusPrompt;
      const data = await postJson('/scheduler/exam-sim', payload);
      if (!data.cards?.length) {
        fb.textContent = `Sin tarjetas disponibles para "${subject}". Creá tarjetas primero.`;
        fb.classList.remove('hidden');
        return;
      }
      closeExamModal();
      startExamSession(data.cards, subject);
    } catch (err) {
      fb.textContent = `Error: ${err.message}`;
      fb.classList.remove('hidden');
    } finally {
      startBtn.disabled = false;
      startBtn.textContent = 'Comenzar simulacro';
    }
  });

  document.querySelector('#exam-again-btn').addEventListener('click', openExamModal);
  document.querySelector('#exam-back-btn').addEventListener('click', () => {
    document.querySelector('#exam-complete').classList.add('hidden');
    document.querySelector('#study-briefing').classList.remove('hidden');
  });
  document.querySelector('#study-start-btn').addEventListener('click', startStudySession);
  document.querySelector('#study-exit-btn').addEventListener('click', exitStudySession);
  document.querySelector('#study-pause-btn').addEventListener('click', toggleStudyPause);
  document.querySelector('#study-resume-btn').addEventListener('click', toggleStudyPause);
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
    () => studyDictBtn.dataset.subject || '',
    () => {
      if (!studyState.voiceMode) return;
      const evalBtn = document.querySelector('#study-eval-btn');
      if (evalBtn && !evalBtn.disabled && evalBtn.offsetParent !== null) evalBtn.click();
    }
  );
  attachMathTabInsertion(
    document.querySelector('#study-answer-input'),
    () => studyState.currentInputMode === 'math'
  );
  MathPreview.attach(
    document.querySelector('#study-answer-input'),
    () => studyState.currentInputMode === 'math'
  );
  setMathHighlightColor(getMathHighlightColor());
  bindStudyKeyboardShortcuts();

  // Single TTS replay button listener (registered once; _ttsCurrentText drives which text to play)
  document.querySelector('#study-tts-btn')?.addEventListener('click', () => {
    if (_ttsCurrentText) playChineseTTS(_ttsCurrentText);
  });

  // Listening variant replay button (prompt-side audio for listening cards)
  document.querySelector('#study-listening-replay-btn')?.addEventListener('click', () => {
    if (_ttsListeningText) playChineseTTS(_ttsListeningText, '#study-listening-replay-btn');
  });

  // ── Binary check button ────────────────────────────────────────────────────
  document.querySelector('#study-binary-check-btn')?.addEventListener('click', async () => {
    const item = studyState.queue[studyState.index];
    if (!item || item.type !== 'card') return;

    const answer = MathPreview.serialize(document.querySelector('#study-answer-input')).trim();
    if (!answer) return;

    const btn = document.querySelector('#study-binary-check-btn');
    const fb  = document.querySelector('#study-check-feedback');
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    fb.textContent = '';
    fb.className = 'study-check-feedback';

    try {
      const resp = await postJson('/evaluate/binary-check', {
        card_id:              item.data.id,
        prompt_text:          item.data.prompt_text,
        user_answer_text:     answer,
        expected_answer_text: item.data.expected_answer_text,
        subject:              item.data.subject || undefined
      });
      if (resp.result === 'ok') {
        fb.textContent = '✓ Va bien';
        fb.className = 'study-check-feedback study-check-ok';
      } else {
        fb.textContent = '✕ Hay un error';
        fb.className = 'study-check-feedback study-check-error';
        if (resp.check_id) studyState.checkFails.push(resp.check_id);
        if (resp.error_type === 'conceptual' && resp.error_label &&
            !studyState.checkErrorLabels.includes(resp.error_label)) {
          studyState.checkErrorLabels.push(resp.error_label);
        }
      }
    } catch (_) {
      fb.textContent = 'Error al verificar';
      fb.className = 'study-check-feedback study-check-error';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verificar';
    }
  });

  // Clear check feedback when the user modifies their answer
  document.querySelector('#study-answer-input')?.addEventListener('input', () => {
    const fb = document.querySelector('#study-check-feedback');
    if (fb && fb.textContent) {
      fb.textContent = '';
      fb.className = 'study-check-feedback';
    }
    // Keep error tags visible — they represent accumulated errors from this session
  });

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

  // ── Toggle card count visibility ─────────────────────────────────────────
  function applyStudyCountHidden(hidden) {
    const summaryEl = document.querySelector('#study-queue-summary');
    const progressBar = document.querySelector('#study-progress-bar');
    const progressText = document.querySelector('#study-progress-text');
    const overviewBtn = document.querySelector('#toggle-study-count-btn');
    const sessionBtn = document.querySelector('#toggle-session-count-btn');
    if (hidden) {
      summaryEl?.classList.add('study-count-hidden');
      progressBar?.classList.add('study-count-hidden');
      progressText?.classList.add('study-count-hidden');
      if (overviewBtn) overviewBtn.textContent = 'Mostrar';
      if (sessionBtn) sessionBtn.textContent = 'Mostrar';
    } else {
      summaryEl?.classList.remove('study-count-hidden');
      progressBar?.classList.remove('study-count-hidden');
      progressText?.classList.remove('study-count-hidden');
      if (overviewBtn) overviewBtn.textContent = 'Ocultar';
      if (sessionBtn) sessionBtn.textContent = 'Ocultar';
    }
  }
  function toggleStudyCount() {
    const hidden = localStorage.getItem('studyCountHidden') === '1';
    const next = !hidden;
    localStorage.setItem('studyCountHidden', next ? '1' : '0');
    applyStudyCountHidden(next);
  }
  applyStudyCountHidden(localStorage.getItem('studyCountHidden') === '1');
  document.querySelector('#toggle-study-count-btn')?.addEventListener('click', toggleStudyCount);
  document.querySelector('#toggle-session-count-btn')?.addEventListener('click', toggleStudyCount);

  restorePersistedStudySession();

  // Auto-pause on tab hide disabled — timer runs regardless of visibility.
  // document.addEventListener('visibilitychange', () => {
  //   const sessionVisible = !document.querySelector('#study-session')?.classList.contains('hidden');
  //   if (!sessionVisible) return;
  //   if (document.hidden) {
  //     if (!studyState.isPaused) {
  //       studyState._autopaused = true;
  //       pauseStudySession(true);
  //     }
  //   } else {
  //     if (studyState._autopaused) {
  //       studyState._autopaused = false;
  //       resumeStudySession(true);
  //     }
  //   }
  // });
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

  // Pre-select configured defaults
  const defTime = getDefaultBriefingTime();
  if (defTime) {
    const btn = document.querySelector(`#briefing-time-options .briefing-opt[data-value="${defTime}"]`);
    if (btn) btn.click();
  }
  const defEnergy = getDefaultBriefingEnergy();
  if (defEnergy) {
    const btn = document.querySelector(`#briefing-energy-options .briefing-opt[data-value="${defEnergy}"]`);
    if (btn) btn.click();
  }
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
      const forcedCount = planned.filter((p) => p.forced).length;
      summaryEl.innerHTML = `
        <div style="font-weight:600;margin-bottom:8px">${planned.length} tarjeta${planned.length !== 1 ? 's' : ''} · ~${data.plan.total_estimated_minutes} min${forcedCount > 0 ? ` · <span class="briefing-forced-badge">${forcedCount} forzada${forcedCount !== 1 ? 's' : ''}</span>` : ''}</div>
        ${planned.map((p) => `
          <div class="briefing-plan-row${p.forced ? ' briefing-plan-row--forced' : ''}">
            <span>${p.subject}${p.forced ? ' <span class="briefing-forced-icon" title="Retención bajo el piso — revisión obligatoria">⚠</span>' : ''}</span>
            <span style="color:var(--text-muted);font-size:0.8rem">~${Math.round(p.estimated_ms / 1000)}s</span>
          </div>`).join('')}
        ${deferred.length > 0 ? `<div class="briefing-deferred">+ ${deferred.length} tarjeta${deferred.length !== 1 ? 's' : ''} postergada${deferred.length !== 1 ? 's' : ''} para otra sesión</div>` : ''}
      `;
      startBtn.classList.remove('hidden');

      // Daily quota nudge
      getJson(`/scheduler/daily-summary?budget_minutes=${getDailyBudget()}`).then((ds) => {
        if (!ds) return;
        const done   = ds.reviews_done_today;
        const target = getDailyTarget();
        const rem    = Math.max(0, target - done);
        if (rem > 0) {
          const nudge = document.createElement('div');
          nudge.className = 'briefing-daily-nudge';
          nudge.textContent = `Meta diaria: ${done}/${target} revisiones · te quedan ${rem}`;
          summaryEl.appendChild(nudge);
        }
      }).catch(() => {});

      // Agent reasoning log
      if (data.plan.agent_log) {
        const logToggle = document.createElement('div');
        logToggle.className = 'briefing-agent-log-toggle';
        logToggle.innerHTML = `<button class="btn-ghost briefing-agent-log-btn">Ver razonamiento del agente ▾</button>`;
        const logBody = document.createElement('div');
        logBody.className = 'briefing-agent-log-body hidden';
        logBody.textContent = data.plan.agent_log;
        logToggle.querySelector('.briefing-agent-log-btn').addEventListener('click', () => {
          const isHidden = logBody.classList.toggle('hidden');
          logToggle.querySelector('.briefing-agent-log-btn').textContent =
            isHidden ? 'Ver razonamiento del agente ▾' : 'Ocultar razonamiento ▴';
        });
        logToggle.appendChild(logBody);
        summaryEl.appendChild(logToggle);
      }
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

function _doStartPlannedSession() {
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
  studyState.pendingCompletion     = null;
  studyState.sessionStartTime      = Date.now();
  studyState.sessionLimitMs        = briefingState.selectedTime * 60 * 1000;
  studyState.sessionEnergyLevel    = briefingState.selectedEnergy;
  studyState.sessionPausedMs       = 0;
  studyState.isPaused              = false;
  studyState.pausedAt              = 0;
  studyState.lastBreakNudgeMinuteKey = null;

  // Record session start for calibration
  postJson('/study/sessions', {
    planned_minutes:    briefingState.selectedTime,
    planned_card_count: queue.length,
    energy_level:       briefingState.selectedEnergy
  }).then(d => {
    studyState.sessionId = d?.session_id ?? null;
    if (studyState.pendingCompletion && studyState.sessionId) {
      const { actualMinutes, cardCount } = studyState.pendingCompletion;
      studyState.pendingCompletion = null;
      const sid = studyState.sessionId;
      studyState.sessionId = null;
      postJson(`/study/sessions/${sid}`, {
        actual_minutes:    actualMinutes,
        actual_card_count: cardCount,
      }, 'PATCH').catch(() => {});
    }
  }).catch(() => {});

  document.querySelector('#study-briefing').classList.add('hidden');
  document.querySelector('#study-overview').classList.add('hidden');
  document.querySelector('#study-complete').classList.add('hidden');
  document.querySelector('#study-session').classList.remove('hidden');

  startStudyRealtimeScheduler();
  persistStudySession();
  showStudyCard();
}

async function startPlannedSession() {
  if (userSettings.time_restriction_enabled && !isAllowedStartTime()) { showTimeRestrictionModal(); return; }
  const gateEl = document.querySelector('#briefing-planner-gate');
  if (userSettings.planner_gate_enabled) {
    const status = await checkPlannerDayStatus();
    if (!status.is_full) { renderPlannerGate(gateEl, status.filled ?? 0, status.total ?? 32); return; }
  }
  gateEl?.classList.add('hidden');
  showGratitudeModal(() => _doStartPlannedSession());
}

function recordSessionCompletion(cardCount) {
  if (!studyState.sessionStartTime) return;
  // Flush any active pause before measuring
  if (studyState.isPaused) {
    studyState.sessionPausedMs += Date.now() - studyState.pausedAt;
    studyState.isPaused = false;
    studyState.pausedAt = 0;
  }
  const actualMinutes = Math.round(
    (Date.now() - studyState.sessionStartTime - studyState.sessionPausedMs) / 60000 * 100
  ) / 100;
  const resolvedCardCount = cardCount ?? studyState.results.length;

  if (!studyState.sessionId) {
    // POST hasn't resolved yet — defer PATCH until sessionId arrives
    studyState.pendingCompletion = { actualMinutes, cardCount: resolvedCardCount };
    return;
  }

  const sessionId = studyState.sessionId;
  studyState.sessionId = null;
  return postJson(`/study/sessions/${sessionId}`, {
    actual_minutes:    actualMinutes,
    actual_card_count: resolvedCardCount,
  }, 'PATCH').catch(() => {});
}

function exitStudySession() {
  if (studyState.isPaused) {
    studyState.sessionPausedMs += Date.now() - studyState.pausedAt;
    studyState.isPaused = false;
    studyState.pausedAt = 0;
  }
  if (studyState.timerInterval) {
    clearInterval(studyState.timerInterval);
    studyState.timerInterval = null;
  }
  stopStudyRealtimeScheduler();
  document.querySelector('#study-session').classList.add('hidden');
  document.querySelector('#study-overview').classList.remove('hidden');
  recordSessionCompletion(studyState.results.length);
  studyState.sessionStartTime = null;
  persistStudySession();
}

function toggleStudyPause() {
  if (studyState.isPaused) {
    resumeStudySession();
  } else {
    pauseStudySession();
  }
}

function pauseStudySession(silent = false) {
  if (studyState.isPaused) return;
  if (studyState.timerInterval) {
    clearInterval(studyState.timerInterval);
    studyState.timerInterval = null;
  }
  stopStudyRealtimeScheduler();
  studyState.isPaused = true;
  studyState.pausedAt = Date.now();

  if (!silent) {
    const pauseBtn = document.querySelector('#study-pause-btn');
    if (pauseBtn) { pauseBtn.textContent = 'Reanudar'; pauseBtn.classList.add('study-pause-btn--active'); }
    document.querySelector('#study-pause-overlay')?.classList.remove('hidden');
    document.querySelector('#study-answer-input').disabled = true;
    const evalBtn = document.querySelector('#study-eval-btn');
    if (evalBtn) evalBtn.disabled = true;
  }
}

function resumeStudySession(silent = false) {
  if (!studyState.isPaused) return;
  const pauseDuration = Date.now() - studyState.pausedAt;
  studyState.cardPausedMs += pauseDuration;
  studyState.sessionPausedMs += pauseDuration;
  studyState.isPaused = false;
  studyState.pausedAt = 0;

  if (!silent) {
    const pauseBtn = document.querySelector('#study-pause-btn');
    if (pauseBtn) { pauseBtn.textContent = 'Pausar'; pauseBtn.classList.remove('study-pause-btn--active'); }
    document.querySelector('#study-pause-overlay')?.classList.add('hidden');
    document.querySelector('#study-answer-input').disabled = false;
    const evalBtn = document.querySelector('#study-eval-btn');
    if (evalBtn) evalBtn.disabled = false;
  }

  const timerEl = document.querySelector('#study-timer');
  studyState.timerInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - studyState.cardStartTime - studyState.cardPausedMs) / 1000);
    timerEl.textContent = `${elapsed}s`;
  }, 1000);
  startStudyRealtimeScheduler();
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
  const saveBtn = document.querySelector('#card-save-btn');

  if (!prompt || !expected) {
    showToast('La pregunta y la respuesta esperada son obligatorias.', 'error');
    return;
  }

  try {
    saveNewCard.isSaving = true;
    if (saveBtn) saveBtn.disabled = true;
    const createdCard = await postJson('/scheduler/cards', { subject, prompt_text: prompt, expected_answer_text: expected });
    const nextReview = createdCard?.next_review_at ? new Date(createdCard.next_review_at) : null;
    const now = new Date();
    const releaseDay = nextReview ? nextReview.toDateString() : now.toDateString();
    const msg = releaseDay !== now.toDateString()
      ? `Tarjeta guardada. Se libera el ${nextReview.toLocaleDateString('es-AR')}.`
      : 'Tarjeta guardada.';
    showToast(msg, 'success');
    document.querySelector('#card-subject').value = subject;
    document.querySelector('#card-prompt').value = '';
    document.querySelector('#card-expected').value = '';
    document.querySelector('#card-prompt').focus();
    loadBrowserCards().catch(() => {});
    loadStudyOverview().catch(() => {});
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
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
  isPaused: false,
  pausedAt: 0,
  cardPausedMs: 0,
  sessionPausedMs: 0,
  sessionId: null,
  sessionStartTime: 0,
  sessionLimitMs: null,
  sessionEnergyLevel: null,
  sessionSchedulerInterval: null,
  lastBreakNudgeMinuteKey: null,
  // Exam mode extras
  examMode: false,
  examSubject: null,
  examItemResults: [],  // {grade, prompt_text, expected_answer_text, passed}
  // Binary check tool
  checkFails: [],       // IDs from binary_check_log for negative checks this card
  checkErrorLabels: [], // conceptual error labels to show in result block
  voiceMode: false,
  voicePhase: 'idle',
  audioPlaying: false,
  isAdvancingCard: false
};

function maybeSendBreakNudge() {
  if (!userSettings.realtime_break_notifications_enabled) return;
  if (!studyState.sessionStartTime || studyState.isPaused) return;
  const now = new Date();
  const minute = now.getMinutes();
  if (minute !== 25 && minute !== 55) return;

  const minuteKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${minute}`;
  if (studyState.lastBreakNudgeMinuteKey === minuteKey) return;
  studyState.lastBreakNudgeMinuteKey = minuteKey;
  persistStudySession();

  if (!('Notification' in window)) return;
  const body = minute === 25
    ? 'Descanso sugerido. Volvé en el minuto 30.'
    : 'Descanso sugerido. Volvé en el minuto 00.';
  const title = 'Pausa de estudio';
  const emit = () => {
    try { new Notification(title, { body }); } catch (_) {}
  };

  if (Notification.permission === 'granted') {
    emit();
  } else if (Notification.permission === 'default') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') emit();
    }).catch(() => {});
  }
}

function stopStudyRealtimeScheduler() {
  if (!studyState.sessionSchedulerInterval) return;
  clearInterval(studyState.sessionSchedulerInterval);
  studyState.sessionSchedulerInterval = null;
}

function startStudyRealtimeScheduler() {
  stopStudyRealtimeScheduler();
  studyState.sessionSchedulerInterval = setInterval(() => {
    maybeSendBreakNudge();
  }, 1000);
  maybeSendBreakNudge();
}

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

// Show the binary check row only when the active editor is Math or SQL.
function syncCheckBtn() {
  const row = document.querySelector('#study-check-row');
  if (!row) return;
  const active = studyState.currentInputMode === 'math' || studyState.currentInputMode === 'sql';
  row.classList.toggle('hidden', !active);
}

function getStudyPromptText(item) {
  if (!item) return '';
  if (item.type === 'micro') {
    return item.data.session_question || item.data.question;
  }
  return item.data.session_prompt_text || item.data.prompt_text;
}

function getStudyExpectedText(item) {
  if (!item) return '';
  return item.type === 'micro'
    ? (item.data.expected_answer || '')
    : (item.data.expected_answer_text || '');
}

function setStudyPromptFeedback(message, type = 'info') {
  const feedbackEl = document.querySelector('#study-prompt-feedback');
  if (!feedbackEl) return;
  feedbackEl.textContent = message || '';
  feedbackEl.classList.toggle('hidden', !message);
  feedbackEl.style.color = type === 'error' ? '#c00' : type === 'success' ? '#2f7d32' : '';
}

function startExamSession(cards, subject) {
  studyState.queue              = cards.map((c) => ({ type: 'card', data: c }));
  studyState.index              = 0;
  studyState.results            = [];
  studyState.examMode           = true;
  studyState.examSubject        = subject;
  studyState.examItemResults    = [];
  studyState.pendingMicroGeneration = 0;
  studyState.sessionId          = null;
  studyState.sessionStartTime   = Date.now();
  studyState.sessionLimitMs     = null;
  studyState.sessionPausedMs    = 0;
  studyState.isPaused           = false;
  studyState.pausedAt           = 0;
  studyState.lastBreakNudgeMinuteKey = null;

  postJson('/study/sessions', {
    planned_minutes:    0,
    planned_card_count: studyState.queue.length
  }).then(d => { studyState.sessionId = d?.session_id ?? null; }).catch(() => {});

  document.querySelector('#study-overview').classList.add('hidden');
  document.querySelector('#study-complete').classList.add('hidden');
  document.querySelector('#exam-complete').classList.add('hidden');
  document.querySelector('#study-briefing').classList.add('hidden');
  document.querySelector('#study-session').classList.remove('hidden');
  document.querySelector('#exam-mode-badge').classList.remove('hidden');

  startStudyRealtimeScheduler();
  persistStudySession();
  showStudyCard();
}

// ── Gratitude modal ───────────────────────────────────────────────────────────
// Shows the gratitude modal and resolves once the user has submitted and
// acknowledged the response.  Pass a callback that starts the actual session.
function isAllowedStartTime() {
  const min = new Date().getMinutes();
  return min === 0 || min === 30;
}

function showTimeRestrictionModal() {
  const modal    = document.querySelector('#time-restrict-modal');
  const nextEl   = document.querySelector('#time-restrict-next');
  const closeBtn = document.querySelector('#time-restrict-close-btn');
  const backdrop = document.querySelector('#time-restrict-backdrop');

  const min      = new Date().getMinutes();
  const wait     = min < 30 ? 30 - min : 60 - min;
  nextEl.textContent = `Próximo horario disponible en ${wait} minuto${wait !== 1 ? 's' : ''}.`;

  modal.classList.remove('hidden');

  function close() {
    modal.classList.add('hidden');
    closeBtn.removeEventListener('click', close);
    backdrop.removeEventListener('click', close);
  }
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
}

function showGratitudeModal(onConfirm) {
  if (!userSettings.gratitude_enabled) { onConfirm(); return; }
  const modal      = document.querySelector('#gratitude-modal');
  const input      = document.querySelector('#gratitude-input');
  const submitBtn  = document.querySelector('#gratitude-submit-btn');
  const startBtn   = document.querySelector('#gratitude-start-btn');
  const errorEl    = document.querySelector('#gratitude-error');
  const responseArea = document.querySelector('#gratitude-response-area');
  const responseText = document.querySelector('#gratitude-response-text');

  // Reset state
  input.value = '';
  errorEl.classList.add('hidden');
  responseArea.classList.add('hidden');
  submitBtn.classList.remove('hidden');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Continuar';
  startBtn.classList.add('hidden');

  modal.classList.remove('hidden');
  input.focus();

  function close() {
    modal.classList.add('hidden');
    submitBtn.removeEventListener('click', handleSubmit);
    startBtn.removeEventListener('click', handleStart);
  }

  async function handleSubmit() {
    const text = input.value.trim();
    if (text.length < 3) {
      showToast('Escribí al menos unas palabras por las que estés agradecido.', 'error');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';

    try {
      const data = await postJson('/gratitude', { text });
      if (data.response) {
        responseText.textContent = data.response;
        responseArea.classList.remove('hidden');
      }
      submitBtn.classList.add('hidden');
      startBtn.classList.remove('hidden');
    } catch (err) {
      showToast(`Error al guardar: ${err.message}`, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Continuar';
    }
  }

  function handleStart() {
    close();
    onConfirm();
  }

  submitBtn.addEventListener('click', handleSubmit);
  startBtn.addEventListener('click', handleStart);

  // Allow submitting with Enter (Ctrl+Enter for textarea)
  input.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      input.removeEventListener('keydown', onKey);
      handleSubmit();
    }
  });
}

async function _doStartStudySession() {
  studyState.voiceMode = Boolean(document.querySelector('#study-voice-mode-toggle')?.checked);
  const subjectQuery = briefingState.selectedSubject
    ? `?subject=${encodeURIComponent(briefingState.selectedSubject)}`
    : '';
  const separator = subjectQuery ? '&' : '?';
  const voiceQuery = studyState.voiceMode ? `${separator}mode=voice` : '';
  const data = await getJson(`/scheduler/session${subjectQuery}${voiceQuery}`);
  const micros = (data.micro_cards ?? []).map((m) => ({ type: 'micro', data: m }));
  const cards  = (data.cards ?? []).map((c) => ({ type: 'card', data: c }));

  const sortByPerformance = (items) => items.slice().sort((a, b) => {
    const da = a.data, db = b.data;
    const aNew = (da.review_count ?? 0) === 0;
    const bNew = (db.review_count ?? 0) === 0;
    if (aNew !== bNew) return aNew ? -1 : 1;
    const scoreOf = (d) => d.pass_count != null && d.review_count
      ? d.pass_count / d.review_count
      : (d.ease_factor ?? 2.5);
    return scoreOf(da) - scoreOf(db);
  });
  studyState.queue              = [...sortByPerformance(cards), ...sortByPerformance(micros)];
  studyState.index              = 0;
  studyState.results            = [];
  studyState.pendingMicroGeneration = 0;
  studyState.currentEvalResult  = null;
  studyState.currentEvalContext = null;
  studyState.currentDecision    = null;
  studyState.sessionId          = null;
  studyState.sessionStartTime   = Date.now();
  studyState.sessionLimitMs     = null; // ad-hoc: no time limit (8 h expiry)
  studyState.sessionEnergyLevel = briefingState.selectedEnergy || null;
  studyState.sessionPausedMs    = 0;
  studyState.isPaused           = false;
  studyState.pausedAt           = 0;
  studyState.lastBreakNudgeMinuteKey = null;
  renderStudyBackgroundStatus();

  if (studyState.queue.length === 0) {
    loadStudyOverview();
    return;
  }

  // Pre-fetch TTS for the first two items so the first card plays without delay.
  if (studyState.voiceMode) {
    [studyState.queue[0], studyState.queue[1]].forEach((it) => {
      if (!it) return;
      prefetchVoiceFront(getStudyPromptText(it));
      const exp = getStudyExpectedText(it);
      if (exp) prefetchVoiceFront(exp);
    });
  }

  postJson('/study/sessions', {
    planned_minutes:    0,
    planned_card_count: studyState.queue.length,
    energy_level:       studyState.sessionEnergyLevel
  }).then(d => { studyState.sessionId = d?.session_id ?? null; }).catch(() => {});

  document.querySelector('#study-overview').classList.add('hidden');
  document.querySelector('#study-add-form').classList.add('hidden');
  document.querySelector('#study-complete').classList.add('hidden');
  document.querySelector('#study-session').classList.remove('hidden');

  startStudyRealtimeScheduler();
  persistStudySession();
  showStudyCard();
}

async function checkPlannerDayStatus() {
  try {
    const res = await fetch('/planner/day-status', {
      headers: Auth.getToken() ? { 'Authorization': 'Bearer ' + Auth.getToken() } : {}
    });
    if (!res.ok) return { is_full: true }; // fail open — server error shouldn't block studying
    return await res.json();
  } catch {
    return { is_full: true }; // fail open — offline/network error
  }
}

function renderPlannerGate(gateEl, filled, total) {
  const missing = total - filled;
  gateEl.innerHTML = `
    <span class="planner-gate-text">
      Planificá tu día antes de estudiar — faltan <strong>${missing} bloque${missing !== 1 ? 's' : ''}</strong> por completar.
    </span>
    <button type="button" class="btn-secondary">Ir a Planificar</button>
  `;
  gateEl.querySelector('button').addEventListener('click', () => {
    document.querySelector('[data-tab="planner"]').click();
  });
  gateEl.classList.remove('hidden');
}

async function startStudySession() {
  if (userSettings.time_restriction_enabled && !isAllowedStartTime()) { showTimeRestrictionModal(); return; }
  const gateEl = document.querySelector('#overview-planner-gate');
  if (userSettings.planner_gate_enabled) {
    const status = await checkPlannerDayStatus();
    if (!status.is_full) { renderPlannerGate(gateEl, status.filled ?? 0, status.total ?? 32); return; }
  }
  gateEl?.classList.add('hidden');
  showGratitudeModal(() => _doStartStudySession());
}

function addCheckErrorTag(label) {
  const container = document.querySelector('#study-check-error-tags-result');
  if (!container) return;
  const existing = Array.from(container.querySelectorAll('.check-error-tag-label'))
    .map((el) => el.textContent);
  if (existing.includes(label)) return;
  const tag = document.createElement('span');
  tag.className = 'check-error-tag';
  tag.innerHTML = `<span>⚠</span><span class="check-error-tag-label">${label}</span><span class="check-error-tag-hint">→ micro-tarjeta</span>`;
  container.appendChild(tag);
  container.classList.remove('hidden');
}

function clearCheckErrorTags() {
  const container = document.querySelector('#study-check-error-tags-result');
  if (!container) return;
  container.innerHTML = '';
  container.classList.add('hidden');
}

function summarizeJustificationLine(result = {}) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = buildJustificationHtml(result);
  const text = (wrapper.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const [first] = text.split(/[.!?]\s+/).filter(Boolean);
  return (first || text).trim().replace(/[.!?]+$/, '') + '.';
}

function showStudyCard() {
  _voiceEpoch++;                          // invalidate any in-flight playStudyVoiceFront call
  if (_voiceFrontAudio) {
    try { _voiceFrontAudio.pause(); } catch (_) {}
    _voiceFrontAudio = null;
  }
  studyState.audioPlaying = false;
  studyState.voicePhase = 'idle';
  const item = studyState.queue[studyState.index];
  if (!item) { finishStudySession(); return; }

  const total   = studyState.queue.length;
  const current = studyState.index + 1;

  document.querySelector('#study-progress-text').textContent = `${current} / ${total}`;
  const pct = Math.round(((current - 1) / total) * 100);
  document.querySelector('#study-progress-fill').style.width = `${pct}%`;

  const badgesEl = document.querySelector('#study-card-badges');
  const subjectEl = document.querySelector('#study-card-subject');
  const promptEl = document.querySelector('#study-card-prompt');
  const parentContextEl = document.querySelector('#study-card-parent-context');
  const parentPromptEl  = document.querySelector('#study-card-parent-prompt');
  const subject = item.type === 'micro' ? (item.data.parent_subject ?? item.data.subject) : item.data.subject;
  const subjectLabel = subject || '(sin materia)';

  subjectEl.textContent = `Materia: ${subjectLabel}`;

  const listeningBar = document.querySelector('#study-listening-bar');
  const isListeningVariant = item.type === 'card' && item.data.variant_type === 'listening';

  // Build status badges for the top of the card
  const cardBadges = [];
  if (item.type === 'micro') {
    cardBadges.push('<span class="study-card-badge study-card-badge--micro">Micro-concepto</span>');
  } else {
    if (Number(item.data.review_count) === 0) {
      cardBadges.push('<span class="study-card-badge study-card-badge--cluster-new">Cluster nuevo</span>');
    }
    if (item.data.variant_id != null && Number(item.data.variant_review_count ?? 0) === 0) {
      cardBadges.push('<span class="study-card-badge study-card-badge--variant-new">Variante nueva</span>');
    }
  }
  if (studyState.voiceMode) {
    const epochAtCardStart = _voiceEpoch;
    playStudyVoiceFront(getStudyPromptText(item))
      .then(() => {
        // Only auto-start dictation if we're still on the same card that launched this audio.
        // onpause resolves the Promise when the audio is interrupted; without this check
        // the callback would fire during the *next* card's expected-answer playback.
        if (!studyState.voiceMode || _voiceEpoch !== epochAtCardStart) return;
        const dictBtn = document.querySelector('#study-dictation-btn');
        if (dictBtn && !dictBtn.disabled && dictBtn.offsetParent !== null) dictBtn.click();
      })
      .catch(() => {});
    // Pre-fetch TTS for the current item's expected answer and next item's prompt + expected answer.
    const currentExpected = getStudyExpectedText(item);
    if (currentExpected) prefetchVoiceFront(currentExpected);
    const nextItem = studyState.queue[studyState.index + 1];
    if (nextItem) {
      prefetchVoiceFront(getStudyPromptText(nextItem));
      const nextExpected = getStudyExpectedText(nextItem);
      if (nextExpected) prefetchVoiceFront(nextExpected);
    }
  }
  badgesEl.innerHTML = cardBadges.join('');

  if (item.type === 'micro') {
    // Show parent card as context so student knows what topic this stems from
    if (item.data.parent_prompt) {
      parentPromptEl.textContent = item.data.parent_prompt;
      parentContextEl.classList.remove('hidden');
    } else {
      parentContextEl.classList.add('hidden');
    }
    // Detect listening microcards: explicit presentation tag OR legacy cards where
    // the question is pure hanzi (no presentation tag set at creation time).
    const _microQuestion = item.data.question || '';
    const _microExpected = item.data.expected_answer || '';
    const isMicroListening = item.data.presentation === 'listening'
      || (hasChinese(_microQuestion) && hasChinese(_microExpected)
          && item.data.presentation !== 'lexical' && item.data.presentation !== 'text');

    if (isMicroListening) {
      // Listening micro-card: hide question text, play audio of the Hanzi to drill.
      promptEl.innerHTML = '';
      // Guard: if question has no CJK (bad legacy data), fall back to parent context.
      _ttsListeningText = /[一-鿿㐀-䶿]/u.test(_microQuestion) ? _microQuestion : (item.data.parent_prompt || _microQuestion);
      if (listeningBar) listeningBar.classList.remove('hidden');
      if (getTTSEnabled()) playChineseTTS(_ttsListeningText, '#study-listening-replay-btn');
    } else {
      renderStudyPrompt(promptEl, getStudyPromptText(item));
      if (listeningBar) listeningBar.classList.add('hidden');
      _ttsListeningText = null;
    }
  } else {
    parentContextEl.classList.add('hidden');

    // A corrupted regular variant for a Chinese card may have hanzi in prompt_text
    // (LLM wrote the question in Chinese instead of Spanish). Treat it the same as
    // a listening variant so the student isn't shown raw hanzi on the front.
    const promptForDisplay = getStudyPromptText(item);
    const isCorruptedChinesePrompt = !isListeningVariant
      && hasChinese(promptForDisplay)
      && hasChinese(item.data.expected_answer_text || '');

    if (isListeningVariant || isCorruptedChinesePrompt) {
      // Hide the text prompt; show the listening bar and auto-play TTS.
      promptEl.innerHTML = '';
      _ttsListeningText = item.data.prompt_text;
      if (listeningBar) listeningBar.classList.remove('hidden');
      if (getTTSEnabled()) playChineseTTS(_ttsListeningText, '#study-listening-replay-btn');
    } else {
      renderStudyPrompt(promptEl, promptForDisplay);
      if (listeningBar) listeningBar.classList.add('hidden');
      _ttsListeningText = null;
    }
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

  // Enlarge textarea font for Chinese cards so Hanzi are readable while typing
  const _expectedForFont = item.type === 'micro' ? item.data.expected_answer : item.data.expected_answer_text;
  _studyInput.classList.toggle('chinese-input', hasChinese(_expectedForFont));
  document.querySelector('#study-answer-block').classList.remove('hidden');
  document.querySelector('#study-result-block').classList.add('hidden');
  document.querySelector('#study-doubt-section')?.classList.add('hidden');
  const advancedPanel = document.querySelector('#study-advanced-panel');
  const advancedToggleBtn = document.querySelector('#study-advanced-toggle-btn');
  if (advancedPanel) advancedPanel.open = false;
  if (advancedToggleBtn) {
    advancedToggleBtn.textContent = 'Ver explicación';
    advancedToggleBtn.setAttribute('aria-expanded', 'false');
  }
  const easyPanel = document.querySelector('#study-easy-explanation');
  if (easyPanel) { easyPanel.open = false; easyPanel.classList.add('hidden'); }
  // In exam mode hide secondary controls that don't belong in a simulation
  const studyFlagBtn   = document.querySelector('#study-flag-btn');
  const studyClarify   = document.querySelector('#study-clarify-prompt-btn');
  const studyEditPrompt = document.querySelector('#study-edit-prompt-btn');
  if (studyFlagBtn)    studyFlagBtn.hidden   = studyState.examMode;
  if (studyClarify)    studyClarify.hidden   = studyState.examMode;
  if (studyEditPrompt) studyEditPrompt.hidden = studyState.examMode;
  const studyEvalBtn = document.querySelector('#study-eval-btn');
  studyEvalBtn.disabled = false;
  studyState.currentEvalResult = null;
  studyState.currentEvalContext = null;
  studyState.currentDecision = null;
  studyState.checkFails = [];
  studyState.checkErrorLabels = [];
  const _checkFb = document.querySelector('#study-check-feedback');
  if (_checkFb) { _checkFb.textContent = ''; _checkFb.className = 'study-check-feedback'; }
  clearCheckErrorTags();
  // Reset SQL compiler panel for study session
  const studyCompilerPanel = document.querySelector('#study-sql-compiler');
  const studyCompilerOut   = document.querySelector('#study-compiler-output');
  if (studyCompilerOut) { studyCompilerOut.className = 'sql-compiler-output hidden'; studyCompilerOut.textContent = ''; }

  // Start timer (reset pause state for new card)
  if (studyState.timerInterval) clearInterval(studyState.timerInterval);
  if (studyState.isPaused) {
    studyState.sessionPausedMs += Date.now() - studyState.pausedAt;
    studyState.isPaused = false;
    studyState.pausedAt = 0;
  }
  studyState.cardPausedMs = 0;
  studyState.cardStartTime = Date.now();
  studyState.responseTimeMs = 0;
  studyState.reviewStartTime = 0;
  studyState.reviewTimeMs = 0;
  const timerEl = document.querySelector('#study-timer');
  timerEl.textContent = '0s';
  studyState.timerInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - studyState.cardStartTime - studyState.cardPausedMs) / 1000);
    timerEl.textContent = `${elapsed}s`;
  }, 1000);
  const _pauseBtn = document.querySelector('#study-pause-btn');
  if (_pauseBtn) { _pauseBtn.textContent = 'Pausar'; _pauseBtn.classList.remove('study-pause-btn--active'); }
  document.querySelector('#study-pause-overlay')?.classList.add('hidden');
  document.querySelector('#study-answer-input').disabled = false;

  // Update subject for dictation (attached once in initStudyTab)
  document.querySelector('#study-dictation-btn').dataset.subject = subject || '';

  // Math Palette + SQL Editor — use saved mode, explicit only (no auto-detect)
  const studyAnswerInput = document.querySelector('#study-answer-input');
  MathPalette.setActiveTextarea(studyAnswerInput);
  const savedMode   = getSubjectMode(subject);
  const isMicro     = item.type === 'micro';
  const studySqlMode = savedMode === 'sql';
  studyState.currentInputMode = savedMode === 'math' ? 'math' : studySqlMode ? 'sql' : '';
  syncCheckBtn();

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

  // ── Mode selector (Texto / SQL/PL / Math) ────────────────────────────────
  const modeSelect = document.querySelector('#study-mode-select');
  if (modeSelect) {
    modeSelect.hidden = false;
    modeSelect.value = savedMode;

    const applyMode = (mode) => {
      saveSubjectMode(subject, mode);
      studyState.currentInputMode = mode;
      syncCheckBtn();
      const input = document.querySelector('#study-answer-input');
      const panel = document.querySelector('#study-sql-compiler');
      MathPalette.setActiveTextarea(input);
      if (mode === 'sql') {
        MathPalette.hide();
        SqlEditor.activate(input);
        panel?.classList.remove('hidden');
      } else if (mode === 'math') {
        SqlEditor.deactivate();
        MathPalette.show();
        panel?.classList.add('hidden');
      } else {
        SqlEditor.deactivate();
        MathPalette.updateSubject(subject || '');
        panel?.classList.add('hidden');
      }
      MathPreview.refresh(input);
    };

    modeSelect.onchange = () => applyMode(modeSelect.value);
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

function openStudyAnswerEdit(item, expectedEl) {
  if (item.type === 'micro') return;
  if (document.querySelector('#study-answer-edit-container')) return;

  const currentText = item.data.expected_answer_text || '';

  const container = document.createElement('div');
  container.id = 'study-answer-edit-container';
  container.style.cssText = 'margin-top:10px;padding:10px 12px;border:1px solid var(--border-mid);border-radius:6px;background:var(--bg-subtle)';

  const label = document.createElement('div');
  label.style.cssText = 'font-size:0.82rem;font-weight:600;margin-bottom:6px;color:var(--text-muted)';
  label.textContent = 'Editar respuesta esperada:';

  const ta = document.createElement('textarea');
  ta.rows = 8;
  ta.style.cssText = 'width:100%;box-sizing:border-box;font-family:monospace;font-size:0.84rem';
  ta.value = currentText;

  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;align-items:center';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn-secondary';
  saveBtn.style.fontSize = '0.85rem';
  saveBtn.textContent = 'Guardar';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-ghost';
  cancelBtn.style.fontSize = '0.85rem';
  cancelBtn.textContent = 'Cancelar';

  const fb = document.createElement('span');
  fb.style.cssText = 'font-size:0.8rem;margin-left:4px';

  actionsRow.append(saveBtn, cancelBtn, fb);
  container.append(label, ta, actionsRow);
  expectedEl.appendChild(container);
  ta.focus();

  cancelBtn.addEventListener('click', () => container.remove());

  saveBtn.addEventListener('click', async () => {
    const newText = ta.value.trim();
    if (!newText) { fb.textContent = 'No puede estar vacía.'; fb.style.color = 'var(--fail-fg)'; return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Guardando...';
    fb.textContent = '';
    try {
      await postJson('/cards/batch', { action: 'edit', ids: [item.data.id], expected_answer_text: newText });
      item.data.expected_answer_text = newText;
      container.remove();
      // Replace the "Respuesta esperada" block in the display
      for (const block of expectedEl.querySelectorAll('.study-answer-compare-block')) {
        if (block.querySelector('strong')?.textContent?.includes('Respuesta esperada')) {
          const tmp = document.createElement('div');
          tmp.innerHTML = formatAnswerBlock('Respuesta esperada', newText);
          block.replaceWith(tmp.firstElementChild);
          break;
        }
      }
      setStudyPromptFeedback('Respuesta esperada guardada.', 'success');
    } catch (_) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar';
      fb.textContent = 'Error al guardar.';
      fb.style.color = 'var(--fail-fg)';
    }
  });
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
    ? (item.data.expected_answer || item.data.parent_expected)
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
    const sql = MathPreview.serialize(document.querySelector('#study-answer-input')).trim();
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
  const answer   = MathPreview.serialize(document.querySelector('#study-answer-input')).trim();
  const evalBtn  = document.querySelector('#study-eval-btn');

  if (!answer) return;

  // Stop timer and record response time
  if (studyState.timerInterval) {
    clearInterval(studyState.timerInterval);
    studyState.timerInterval = null;
  }
  studyState.responseTimeMs = Date.now() - studyState.cardStartTime - studyState.cardPausedMs;

  evalBtn.disabled = true;
  evalBtn.textContent = 'Evaluando...';
  setStudyPromptFeedback('');

  let prompt_text, expected_answer_text, subject, grading_rubric;

  if (item.type === 'micro') {
    prompt_text          = getStudyPromptText(item);
    expected_answer_text = item.data.expected_answer || item.data.parent_expected;
    subject              = item.data.parent_subject ?? item.data.subject;
    grading_rubric       = undefined;
  } else {
    prompt_text          = getStudyPromptText(item);
    expected_answer_text = item.data.expected_answer_text;
    subject              = item.data.subject;
    grading_rubric       = Array.isArray(item.data.grading_rubric) && item.data.grading_rubric.length > 0
      ? item.data.grading_rubric
      : undefined;
  }

  const normalizedPrompt = normalize(prompt_text || '');
  const normalizedExpected = normalize(expected_answer_text || '');
  if (normalizedPrompt.length < minRules.prompt_text) {
    evalBtn.disabled = false;
    evalBtn.textContent = 'Evaluar';
    showToast('No se puede evaluar: la consigna de esta tarjeta es demasiado corta o está vacía.', 'error');
    return;
  }
  if (answer.length < minRules.user_answer_text) {
    evalBtn.disabled = false;
    evalBtn.textContent = 'Evaluar';
    showToast('Escribí tu respuesta antes de evaluar.', 'error');
    return;
  }
  if (normalizedExpected.length < minRules.expected_answer_text) {
    evalBtn.disabled = false;
    evalBtn.textContent = 'Evaluar';
    showToast('No se puede evaluar esta tarjeta porque no tiene respuesta esperada cargada.', 'error');
    return;
  }

  try {
    const evaluationPayload = {
      prompt_text: normalizedPrompt,
      user_answer_text: answer,
      expected_answer_text: normalizedExpected,
      ...(subject && subject.trim() ? { subject: subject.trim() } : {}),
      ...(grading_rubric ? { grading_rubric } : {})
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
    justEl.textContent = summarizeJustificationLine(result);
    if (studyState.voiceMode) {
      justEl.textContent = ['GOOD', 'EASY'].includes(grade) ? 'Bien.' : (justEl.textContent || 'Revisá esta respuesta.');
    }
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
        return `<span class="study-dimension-chip weak hl-pink">${label}: ${pct}%</span>`;
      }).join('');
      dimsEl.classList.remove('hidden');
    } else {
      dimsEl.innerHTML = '<span class="study-dimension-chip ok hl-green">Buen dominio general en esta respuesta.</span>';
      dimsEl.classList.remove('hidden');
    }

    const concepts = result.missing_concepts ?? [];
    missingEl.textContent = '';
    missingEl.classList.add('hidden');

    const weakTags = weakDimensions.map(([dimension, value]) => {
      const label = DIM_LABELS[dimension] || dimension;
      const pct = Math.round(Number(value) * 100);
      return `<span class="study-dimension-chip weak hl-pink">${label}: ${pct}%</span>`;
    }).join(' ');
    const missingTags = concepts.map((c) => `<span class="concept-tag hl-yellow">${escHtml(c)}</span>`).join(' ');
    const groupedTags = (weakTags || missingTags)
      ? `<div class="study-answer-compare-block"><strong>Etiquetas:</strong> ${weakTags}${weakTags && missingTags ? ' ' : ''}${missingTags}</div>`
      : '';

    // Always show answer comparison.
    const _hasChinese = hasChinese(expected_answer_text);
    expectedEl.innerHTML = `
      ${groupedTags}
      ${formatAnswerBlock('Tu respuesta', answer)}
      ${formatAnswerBlock('Respuesta esperada', expected_answer_text)}
      ${_hasChinese ? '<details class="study-pinyin-details"><summary>Pinyin</summary><p class="study-pinyin-text">…</p></details>' : ''}
    `;
    expectedEl.classList.remove('hidden');

    // Async: fill in pinyin (fetches /tts which also warms the audio cache)
    if (_hasChinese) {
      fetchPinyin(expected_answer_text).then((py) => {
        const pEl = expectedEl.querySelector('.study-pinyin-text');
        if (pEl) pEl.textContent = py || '—';
      }).catch(() => {});
    }

    if (item.type !== 'micro') {
      const editAnswerBtn = document.createElement('button');
      editAnswerBtn.type = 'button';
      editAnswerBtn.className = 'btn-ghost';
      editAnswerBtn.textContent = 'Editar respuesta';
      editAnswerBtn.style.cssText = 'font-size:0.8rem;margin-top:6px;padding:2px 8px';
      editAnswerBtn.addEventListener('click', () => openStudyAnswerEdit(item, expectedEl));
      expectedEl.appendChild(editAnswerBtn);
    }

    // Easy explanation — shown as a collapsible <details> below the answer comparison.
    // Uses the parent card id (variants share the parent's explanation).
    if (item.type !== 'micro') {
      const easyPanel = document.querySelector('#study-easy-explanation');
      const easyText  = document.querySelector('#study-easy-explanation-text');
      if (easyPanel && easyText) {
        const cardId = item.data.id;
        easyPanel.classList.remove('hidden');
        if (item.data.easy_explanation) {
          easyText.textContent = item.data.easy_explanation;
        } else {
          easyText.textContent = 'Generando explicación…';
          postJson(`/scheduler/cards/${cardId}/easy-explanation`, {})
            .then((resp) => {
              if (resp?.easy_explanation) {
                easyText.textContent = resp.easy_explanation;
                item.data.easy_explanation = resp.easy_explanation;
              } else {
                easyPanel.classList.add('hidden');
              }
            })
            .catch(() => { easyPanel.classList.add('hidden'); });
        }
      }
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
          actionsEl.parentNode.insertBefore(studySqlChecklist, actionsEl);
        } else {
          resultBlock.appendChild(studySqlChecklist);
        }
      }
    }

    // Show "Guardar variante" for any regular card (not micro), regardless of grade
    const variantBtn        = document.querySelector('#study-variant-btn');
    const deleteVariantBtn  = document.querySelector('#study-delete-variant-btn');
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
      if (currentItem.data.variant_id) {
        deleteVariantBtn.classList.remove('hidden');
        deleteVariantBtn.disabled = false;
      } else {
        deleteVariantBtn.classList.add('hidden');
      }
    } else {
      variantBtn.classList.add('hidden');
      deleteVariantBtn.classList.add('hidden');
    }
    variantFeedback.classList.add('hidden');
    variantFeedback.textContent = '';
    document.querySelector('#study-variant-preview')?.classList.add('hidden');
    if (studyState.examMode) {
      // Exam mode: auto-accept LLM grade, no decision required, Next enabled immediately.
      // Normalize to lowercase so comparisons and backend recalibration (expects lowercase) work.
      const autoGrade = normalizeSuggestedGrade(result.suggested_grade).toLowerCase();
      studyState.currentDecision = { finalGrade: autoGrade, source: 'llm_auto' };
      if (decisionBlock) decisionBlock.classList.add('hidden');
      nextBtn.disabled = false;
      // Record result for end-of-exam summary
      const passed = autoGrade === 'good' || autoGrade === 'easy' || autoGrade === 'pass';
      studyState.examItemResults.push({
        grade: autoGrade,
        passed,
        prompt_text:          currentItem?.data?.prompt_text || currentItem?.data?.question || '',
        expected_answer_text: currentItem?.data?.expected_answer_text || currentItem?.data?.expected_answer || '',
        cardData:             currentItem?.data
      });
    } else {
      nextBtn.disabled = false;
      if (decisionReason) decisionReason.value = '';
      if (decisionFb) {
        decisionFb.textContent = 'Podés ajustar la firma si querés; si no, “Siguiente” acepta automáticamente la sugerencia.';
        decisionFb.className = 'feedback';
      }
      if (decisionBlock) {
        decisionBlock.classList.remove('hidden');
        decisionBlock.querySelectorAll('button').forEach((btn) => { btn.disabled = false; });
        const archiveBtn = decisionBlock.querySelector('#study-archive-card-btn');
        if (archiveBtn) archiveBtn.hidden = !currentItem || currentItem.type !== 'card';
      }
    }

    document.querySelector('#study-answer-block').classList.add('hidden');
    document.querySelector('#study-result-block').classList.remove('hidden');

    // Show accumulated conceptual error tags from Verificar clicks
    if (studyState.checkErrorLabels.length > 0) {
      studyState.checkErrorLabels.forEach((label) => addCheckErrorTag(label));
    }

    // Chinese TTS: auto-play if expected answer contains Hanzi
    const ttsBar = document.querySelector('#study-tts-bar');
    if (hasChinese(expected_answer_text)) {
      _ttsCurrentText = expected_answer_text;
      if (ttsBar) ttsBar.classList.remove('hidden');
      if (getTTSEnabled()) playChineseTTS(expected_answer_text);
    } else {
      _ttsCurrentText = null;
      if (ttsBar) ttsBar.classList.add('hidden');
    }

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
    if (studyState.voiceMode) {
      // Stop any prompt audio still playing so the audioPlaying guard in
      // handleStudyNextCard doesn't silently abort the auto-advance.
      if (_voiceFrontAudio) {
        try { _voiceFrontAudio.pause(); } catch (_) {}
        _voiceFrontAudio = null;
      }
      studyState.audioPlaying = false;
      studyState.voicePhase = 'idle';
      if (!['GOOD', 'EASY'].includes(grade)) {
        // Read the expected answer aloud so the student hears the correction before advancing.
        await playStudyVoiceFront(expected_answer_text).catch(() => {});
      }
      await handleStudyNextCard();
      return;
    }
  } catch (err) {
    evalBtn.disabled = false;
    evalBtn.textContent = 'Evaluar';
    const isNetworkErr = err instanceof TypeError && /fetch|network/i.test(err.message);
    const validationIssues = formatValidationIssues(err);
    const detail = validationIssues ? `${err.message}\n${validationIssues}` : err.message;
    const userMsg = isNetworkErr
      ? 'Sin conexión con el servidor. Puede estar reiniciándose — intentá de nuevo.'
      : `Error al evaluar: ${detail}`;
    setStudyPromptFeedback(userMsg, 'error');
  }
});

async function playStudyVoiceFront(text) {
  const input = (text || '').trim();
  if (!input) return;
  const myEpoch = _voiceEpoch;
  studyState.voicePhase = 'speaking-front';
  studyState.audioPlaying = true;
  try {
    let audioB64 = _ttsCache.get(`es::${input}`);
    if (!audioB64) {
      const data = await postJson('/tts', { text: input, lang: 'es' });
      audioB64 = data?.audio;
      if (audioB64) _ttsCache.set(`es::${input}`, audioB64);
    }
    // Abort if showStudyCard() advanced to a new card while we were fetching.
    if (!audioB64 || myEpoch !== _voiceEpoch) return;
    const url = `data:audio/mpeg;base64,${audioB64}`;
    const audio = new Audio(url);
    _voiceFrontAudio = audio;
    await new Promise((resolve) => {
      audio.onended = resolve;
      audio.onerror = resolve;
      // onpause fires when showStudyCard() calls audio.pause() to switch cards,
      // which would otherwise leave this promise hanging forever.
      audio.onpause = resolve;
      audio.play().catch(resolve);
    });
  } finally {
    // Only reset shared state if this call is still the current one.
    // A newer epoch means showStudyCard() already reset state for the next card.
    if (myEpoch === _voiceEpoch) {
      _voiceFrontAudio = null;
      studyState.audioPlaying = false;
      studyState.voicePhase = 'idle';
    }
  }
}

function prefetchVoiceFront(text) {
  const input = (text || '').trim();
  if (!input || _ttsCache.has(`es::${input}`)) return;
  postJson('/tts', { text: input, lang: 'es' })
    .then((data) => { if (data?.audio) _ttsCache.set(`es::${input}`, data.audio); })
    .catch(() => {});
}

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
    showToast('Ingresá un motivo de al menos 5 caracteres.', 'error');
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
    showToast(`No se pudo eliminar la tarjeta: ${err.message}`, 'error');
  } finally {
    if (deleteBtn) {
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Eliminar';
    }
  }
}

const studyDecisionBlock = document.querySelector('#study-decision-block');
async function persistStudyDecision(action, reasonText = '') {
  if (!studyState.currentEvalResult || !studyState.currentEvalContext) {
    throw new Error('No hay una evaluación activa para firmar.');
  }
  const reason = normalize(reasonText || '');
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

  if (isArchiveAction) {
    await archiveCurrentStudyCard(reason);
  } else {
    await postJson(DECISION_ENDPOINT, payload);
  }
  studyState.currentDecision = {
    action,
    finalGrade: finalGrade ? finalGrade.toLowerCase() : null
  };
  return { finalGrade, isArchiveAction };
}

if (studyDecisionBlock) {
  studyDecisionBlock.addEventListener('click', async (event) => {
    const action = event.target?.dataset?.studyAction;
    if (!action || !studyState.currentEvalResult || !studyState.currentEvalContext) return;

    const reasonEl = document.querySelector('#study-correction-reason');
    const reason = reasonEl?.value || '';
    const isArchiveAction = action === 'archive-card';

    studyDecisionBlock.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });

    try {
      const { finalGrade } = await persistStudyDecision(action, reason);
      const nextBtn = document.querySelector('#study-next-btn');
      if (nextBtn) nextBtn.disabled = false;
      if (!isArchiveAction && action === 'accept') {
        await handleStudyNextCard();
      } else {
        const msg = isArchiveAction
          ? 'Tarjeta archivada.'
          : (finalGrade ? `Firma guardada (${finalGrade}).` : 'Firma guardada como duda.');
        showToast(msg, 'success');
      }
    } catch (err) {
      const msg = isArchiveAction
        ? `No se pudo archivar la tarjeta: ${err.message}`
        : `No se pudo guardar la firma: ${err.message}`;
      showToast(msg, 'error');
      studyDecisionBlock.querySelectorAll('button').forEach((btn) => { btn.disabled = false; });
    }
  });
}

document.querySelector('#study-variant-btn').addEventListener('click', async () => {
  const item = studyState.queue[studyState.index];
  const variantBtn  = document.querySelector('#study-variant-btn');
  if (!item || item.type !== 'card') return;

  variantBtn.disabled = true;
  variantBtn.textContent = 'Generando...';

  const variantPreview = document.querySelector('#study-variant-preview');
  const variantPreviewQ = document.querySelector('#study-variant-preview-q');
  const variantPreviewA = document.querySelector('#study-variant-preview-a');

  try {
    const resp = await postJson(`/scheduler/cards/${item.data.id}/variant`, {});
    variantBtn.classList.add('hidden');
    showToast('Variante guardada.', 'success');
    if (resp?.variant) {
      variantPreviewQ.textContent = resp.variant.prompt_text || '';
      variantPreviewA.textContent = resp.variant.expected_answer_text || '';
      variantPreview.classList.remove('hidden');
    }
  } catch (err) {
    variantBtn.disabled = false;
    variantBtn.textContent = '+ Guardar variante';
    showToast(`Error al guardar variante: ${err.message}`, 'error');
  }
});

document.querySelector('#study-delete-variant-btn').addEventListener('click', async () => {
  const item = studyState.queue[studyState.index];
  if (!item || item.type !== 'card' || !item.data.variant_id) return;
  if (!confirm('¿Eliminar esta variante? La tarjeta original no se borra.')) return;

  const btn = document.querySelector('#study-delete-variant-btn');
  btn.disabled = true;

  try {
    await deleteJson(`/scheduler/cards/${item.data.id}/variants/${item.data.variant_id}`);
    btn.classList.add('hidden');
    showToast('Variante eliminada.', 'success');
  } catch (err) {
    btn.disabled = false;
    showToast(`Error al eliminar variante: ${err.message}`, 'error');
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
  const expectedAns   = isMicro ? (item.data.expected_answer || item.data.parent_expected) : item.data.expected_answer_text;
  const subject       = isMicro ? (item.data.parent_subject ?? item.data.subject) : item.data.subject;
  const userAnswer    = MathPreview.serialize(document.querySelector('#study-answer-input')).trim();
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

const studyAdvancedToggleBtn = document.querySelector('#study-advanced-toggle-btn');
const studyAdvancedPanel = document.querySelector('#study-advanced-panel');
if (studyAdvancedToggleBtn && studyAdvancedPanel) {
  studyAdvancedToggleBtn.addEventListener('click', () => {
    studyAdvancedPanel.open = !studyAdvancedPanel.open;
    const expanded = studyAdvancedPanel.open;
    studyAdvancedToggleBtn.textContent = expanded ? 'Ocultar explicación' : 'Ver explicación';
    studyAdvancedToggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });
  studyAdvancedPanel.addEventListener('toggle', () => {
    const expanded = studyAdvancedPanel.open;
    studyAdvancedToggleBtn.textContent = expanded ? 'Ocultar explicación' : 'Ver explicación';
    studyAdvancedToggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });
}

async function handleStudyNextCard() {
  if (studyState.isAdvancingCard) return;
  if (studyState.voiceMode && studyState.audioPlaying) return;
  studyState.isAdvancingCard = true;
  try {
  const item   = studyState.queue[studyState.index];
  const evalResult = studyState.currentEvalResult;
  let decision = studyState.currentDecision;
  if (!evalResult) { advanceStudyCard(); return; }
  if (!decision) {
    try {
      const { finalGrade } = await persistStudyDecision('accept');
      decision = studyState.currentDecision;
      showToast(`Firma automática guardada (${finalGrade}).`, 'success');
    } catch (err) {
      showToast(`No se pudo guardar la firma automática: ${err.message}`, 'error');
      return;
    }
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

  // If the main card passed, pull its micro-cards out of the session queue.
  // The backend (POST /scheduler/review) archives them in the DB when isPassGrade.
  if (grade && item.type === 'card') {
    const g = normalizeSuggestedGrade(grade);
    if (g === 'GOOD' || g === 'EASY') {
      const cardId = item.data.id;
      const ahead = studyState.index + 1;
      studyState.queue = [
        ...studyState.queue.slice(0, ahead),
        ...studyState.queue.slice(ahead).filter(
          (q) => !(q.type === 'micro' && q.data.parent_card_id === cardId)
        ),
      ];
    }
  }

  // In exam mode: skip all micro-card generation (evaluation only).
  const shouldGenerateMicros = Boolean(grade && item.type === 'card' && !studyState.examMode);
  const shouldSpawnSiblings  = Boolean(grade && item.type === 'micro' && gaps.length > 0 && !studyState.examMode);

  if (shouldGenerateMicros || shouldSpawnSiblings) {
    studyState.pendingMicroGeneration += 1;
    renderStudyBackgroundStatus();
  }

  if (grade && item.type === 'micro') {
    // Two-consecutive-correct rule applies to Chinese single-word vocabulary micro-cards
    // (e.g. front: "película", back: "电影").
    // Primary signal: presentation === 'lexical' (set by backend at generation time for Type A cards).
    // Legacy fallback: expected answer has 1-4 CJK characters (old cards without the tag).
    const _cjkInExpected = (item.data.expected_answer || '').match(/[一-鿿㐀-䶿]/gu) || [];
    const isChineseVocabMicro = item.data.presentation === 'lexical'
      || (_cjkInExpected.length > 0 && _cjkInExpected.length <= 4);

    const normalizedGrade   = normalizeSuggestedGrade(grade);
    const isPass            = normalizedGrade === 'GOOD' || normalizedGrade === 'EASY';
    const currentStreak     = item.data._sessionCorrectStreak ?? 0;
    // skip_archive and requeue only apply to Chinese vocab micro-cards
    const skipArchive       = isChineseVocabMicro && isPass && currentStreak < 1;
    const nextStreak        = isPass ? currentStreak + 1 : 0;
    const requeueInSession  = isChineseVocabMicro && (!isPass || skipArchive);

    postJson('/scheduler/review', {
      micro_card_id:    item.data.id,
      grade,
      concept_gaps:     gaps,
      user_answer:      studyState.currentEvalContext?.user_answer_text || '',
      response_time_ms: studyState.responseTimeMs || undefined,
      review_time_ms:   studyState.reviewTimeMs   || undefined,
      skip_archive:     skipArchive
    }).then((reviewResp) => {
      const newSiblings = (reviewResp?.new_micro_cards ?? []).map((m) => ({ type: 'micro', data: m }));
      if (newSiblings.length) {
        studyState.queue.splice(studyState.index + 1, 0, ...newSiblings);
        persistStudySession();
      }
      loadAgenda();
    }).catch((err) => {
      console.warn('Micro review record failed:', err.message);
    }).finally(() => {
      if (shouldSpawnSiblings) {
        studyState.pendingMicroGeneration = Math.max(0, (studyState.pendingMicroGeneration || 0) - 1);
        renderStudyBackgroundStatus();
      }
    });

    if (requeueInSession) {
      studyState.queue.push({ type: 'micro', data: { ...item.data, _sessionCorrectStreak: nextStreak } });
      persistStudySession();
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
      card_id:                      item.data.id,
      grade,
      concept_gaps:                 gaps,
      check_fail_ids:               studyState.checkFails,
      response_time_ms:             studyState.responseTimeMs || undefined,
      review_time_ms:               studyState.reviewTimeMs   || undefined,
      user_answer:                  studyState.currentEvalContext?.user_answer_text || '',
      variant_id:                   item.data.variant_id || undefined,
      variant_prompt_text:          item.data.variant_id ? item.data.prompt_text          : undefined,
      variant_expected_answer_text: item.data.variant_id ? item.data.expected_answer_text : undefined,
      variant_type:                 item.data.variant_id ? item.data.variant_type          : undefined
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
  } finally {
    studyState.isAdvancingCard = false;
  }
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
  if (studyState.examMode) { finishExamSession(); return; }

  if (studyState.timerInterval) {
    clearInterval(studyState.timerInterval);
    studyState.timerInterval = null;
  }
  stopStudyRealtimeScheduler();
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

  // Record actual session time for calibration (exclude paused time).
  // Do NOT gate on sessionId: if the POST hasn't resolved yet, recordSessionCompletion
  // stores the data in pendingCompletion and fires the PATCH once the POST resolves.
  if (studyState.sessionStartTime) {
    const elapsedMs  = Date.now() - studyState.sessionStartTime - studyState.sessionPausedMs;
    const actualMin  = Math.round(elapsedMs / 60000);
    recordSessionCompletion(results.length)?.then(() => {
      const plannedMin = briefingState.selectedTime || 0;
      if (plannedMin > 0) {
        const timingEl = document.createElement('p');
        timingEl.style.cssText = 'font-size:0.85rem;color:var(--text-muted);margin-top:4px';
        timingEl.textContent = `Planificaste ${plannedMin} min · Tardaste ${actualMin} min`;
        document.querySelector('#study-complete-summary').appendChild(timingEl);
      }
    });
  }
  studyState.pendingMicroGeneration = 0;
  renderStudyBackgroundStatus();
  clearPersistedStudySession();
  // Nullify sessionStartTime so any in-flight async callback that calls
  // persistStudySession() (e.g. micro-card generation) hits the early-return
  // guard and doesn't re-persist a completed session.
  studyState.sessionStartTime = null;

  loadStudyOverview();
}

function finishExamSession() {
  if (studyState.timerInterval) {
    clearInterval(studyState.timerInterval);
    studyState.timerInterval = null;
  }
  stopStudyRealtimeScheduler();
  document.querySelector('#study-progress-fill').style.width = '100%';
  document.querySelector('#study-session').classList.add('hidden');
  document.querySelector('#exam-mode-badge').classList.add('hidden');
  recordSessionCompletion(studyState.examItemResults?.length ?? 0);
  clearPersistedStudySession();
  studyState.sessionStartTime = null;

  const items   = studyState.examItemResults;
  const total   = items.length;
  // Compute pass from grade directly (don't rely on the stored `passed` flag)
  const isPassGrade = (g) => { const s = (g || '').toLowerCase(); return s === 'good' || s === 'easy' || s === 'pass'; };
  const correct = items.filter((r) => isPassGrade(r.grade)).length;
  const pct     = total > 0 ? Math.round((correct / total) * 100) : 0;

  // Persist simulation log in the background (no await — fire and forget)
  if (total > 0) {
    postJson('/scheduler/exam-sim/log', {
      subject:   studyState.examSubject,
      correct,
      total,
      score_pct: pct,
      results: items.map((r) => ({
        card_id:       r.cardData?.id   ?? null,
        grade:         r.grade,
        prompt_text:   r.prompt_text,
        passed:        isPassGrade(r.grade),
        weakness_score: r.cardData?.weakness_score ?? null
      }))
    }).catch((err) => console.warn('[exam] Failed to save sim log:', err));
  }

  const { label, cls } = pct >= 90 ? { label: 'Excelente', cls: 'excellent' }
                       : pct >= 75 ? { label: 'Aprobado',  cls: 'good' }
                       : pct >= 60 ? { label: 'Ajustado',  cls: 'adjusted' }
                       :             { label: 'Desaprobado', cls: 'fail' };

  document.querySelector('#exam-complete-subject-tag').textContent = studyState.examSubject || '';
  document.querySelector('#exam-score-fraction').textContent = `${correct} / ${total}`;
  document.querySelector('#exam-score-pct').textContent = `${pct}%`;
  const labelEl = document.querySelector('#exam-score-label');
  labelEl.textContent = label;
  labelEl.className = `exam-score-label ${cls}`;

  // Per-card breakdown
  const GRADE_ICON = { again: '✗', hard: '△', good: '✓', easy: '★', uncertain: '?' };
  const breakdownEl = document.querySelector('#exam-breakdown');
  breakdownEl.innerHTML = items.map((r) => {
    const g    = (r.grade || 'uncertain').toLowerCase();
    const icon = GRADE_ICON[g] || '?';
    const prompt = escHtml((r.prompt_text || '').slice(0, 120));
    return `<div class="exam-breakdown-item">
      <span class="exam-breakdown-icon">${icon}</span>
      <span class="exam-breakdown-prompt">${prompt}${r.prompt_text?.length > 120 ? '…' : ''}</span>
      <span class="exam-breakdown-grade ${g}">${g.toUpperCase()}</span>
    </div>`;
  }).join('');

  // "Para repasar" = failed + hard
  const toReview = items.filter((r) => !isPassGrade(r.grade));
  const reviewSection = document.querySelector('#exam-review-section');
  if (toReview.length > 0) {
    const reviewList = document.querySelector('#exam-review-list');
    reviewList.innerHTML = toReview.map((r) =>
      `<div class="exam-review-item">${escHtml((r.prompt_text || '').slice(0, 150))}${r.prompt_text?.length > 150 ? '…' : ''}</div>`
    ).join('');
    reviewSection.classList.remove('hidden');

    // "Estudiar estas ahora" — load failed cards into a regular study session
    document.querySelector('#exam-study-failed-btn').onclick = () => {
      const failedCards = toReview.map((r) => ({ type: 'card', data: r.cardData })).filter((c) => c.data);
      if (!failedCards.length) return;
      studyState.examMode        = false;
      studyState.examItemResults = [];
      studyState.queue           = failedCards;
      studyState.index           = 0;
      studyState.results         = [];
      studyState.sessionStartTime = Date.now();
      document.querySelector('#exam-complete').classList.add('hidden');
      document.querySelector('#study-session').classList.remove('hidden');
      persistStudySession();
      showStudyCard();
    };
  } else {
    reviewSection.classList.add('hidden');
  }

  document.querySelector('#exam-complete').classList.remove('hidden');

  studyState.examMode         = false;
  studyState.pendingMicroGeneration = 0;
  renderStudyBackgroundStatus();
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

const MANUAL_ACTIVITY_TYPES = {
  clase:           { label: 'Clase',         color: '#3b6abf' },
  contenido:       { label: 'Contenido',     color: '#b8600a' },
  estudio_offline: { label: 'Estudio off',   color: '#2d8c56' },
  reunion:         { label: 'Reunión',       color: '#6b47a8' },
  otro:            { label: 'Otro',          color: '#8a6c10' },
};
const MANUAL_ACTIVITY_PERSIST_KEY = 'planner.manualActivity.v1';

const PLANNER_SLOTS = (() => {
  const s = [];
  for (let h = 5; h < 22; h++) {
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
  manualSlots: {},   // key `${dayIndex}_${slot}` → [{activity_type, subject, duration_minutes}]
  saveTimers: {},    // debounce per cell
  activeCell: null,  // currently focused td
  fillDrag: null,    // { source: { content, color, isFixed }, paintedKeys:Set<string> }
  suppressNextClick: false,
  nowMarkerTimer: null,
  totalsCloseHandler: null, // document-level handler to close subject panels
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

function buildPlannerGrid(weekStart, cells, activitySlots = {}, manualSlots = {}) {
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
      // Manual activity badges (bottom-left, colored per type)
      const manualData = manualSlots[key];
      if (manualData && manualData.length > 0 && !plannerIsFutureSlot(weekStart, d, slot)) {
        // Aggregate by type for the badge: show dominant type's color, total minutes
        const byType = {};
        for (const ma of manualData) {
          byType[ma.activity_type] = (byType[ma.activity_type] || 0) + ma.duration_minutes;
        }
        const totalManualMins = Object.values(byType).reduce((s, m) => s + m, 0);
        const dominantType = Object.entries(byType).reduce((a, b) => b[1] > a[1] ? b : a)[0];
        const badge = document.createElement('span');
        badge.className = `planner-manual-badge planner-manual-badge--${dominantType}`;
        badge.textContent = `${totalManualMins}m`;
        const tooltipParts = Object.entries(byType).map(([type, m]) => {
          const info = MANUAL_ACTIVITY_TYPES[type] || { label: type };
          return `${info.label}: ${m}m`;
        });
        badge.title = tooltipParts.join(' · ');
        td.appendChild(badge);
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

// ── Daily study totals bar (tfoot) ────────────────────────────────────────────
function buildPlannerDailyTotals(table, activitySlots, subjectTotals, manualSlots = {}) {
  if (plannerState.totalsCloseHandler) {
    document.removeEventListener('click', plannerState.totalsCloseHandler);
    plannerState.totalsCloseHandler = null;
  }
  const existing = table.querySelector('tfoot.planner-tfoot-totals');
  if (existing) existing.remove();

  function fmtMins(m) {
    if (m <= 0) return '0m';
    return m >= 60
      ? `${Math.floor(m / 60)}h${m % 60 > 0 ? ' ' + (m % 60) + 'm' : ''}`
      : `${m}m`;
  }

  // Auto study minutes per day (from activitySlots)
  const autoTotals = new Array(7).fill(0);
  for (const [key, slot] of Object.entries(activitySlots)) {
    const d = parseInt(key.split('_')[0], 10);
    if (d >= 0 && d < 7) autoTotals[d] += slot.studyMinutes || 0;
  }

  // Auto study per subject per day (from backend)
  const autoSubjects = {};
  for (const row of subjectTotals) {
    const d = row.day_index;
    if (!autoSubjects[d]) autoSubjects[d] = [];
    autoSubjects[d].push({ subject: row.subject, minutes: Number(row.study_minutes) });
  }

  // Manual activity minutes per day, aggregated by type+subject
  const manualTotals = new Array(7).fill(0);
  const manualBreakdown = {}; // day → { 'type|subject' → {type, subject, minutes} }
  for (const [key, activities] of Object.entries(manualSlots)) {
    const d = parseInt(key.split('_')[0], 10);
    if (d < 0 || d >= 7) continue;
    for (const ma of activities) {
      manualTotals[d] += ma.duration_minutes || 0;
      if (!manualBreakdown[d]) manualBreakdown[d] = {};
      const bk = `${ma.activity_type}|${ma.subject || ''}`;
      if (!manualBreakdown[d][bk]) {
        manualBreakdown[d][bk] = { type: ma.activity_type, subject: ma.subject, minutes: 0 };
      }
      manualBreakdown[d][bk].minutes += ma.duration_minutes || 0;
    }
  }

  const combinedTotals = autoTotals.map((a, i) => a + manualTotals[i]);
  if (combinedTotals.every(t => t === 0)) return;

  const tfoot = document.createElement('tfoot');
  tfoot.className = 'planner-tfoot-totals';
  const tr = document.createElement('tr');

  const labelTd = document.createElement('td');
  labelTd.className = 'planner-time planner-total-label';
  labelTd.textContent = 'Total';
  tr.appendChild(labelTd);

  for (let d = 0; d < 7; d++) {
    const td = document.createElement('td');
    td.className = 'planner-daily-total-cell';
    const totalMins  = combinedTotals[d];
    const autoSubs   = autoSubjects[d] || [];
    const manualEntries = Object.values(manualBreakdown[d] || {})
      .sort((a, b) => b.minutes - a.minutes);
    const hasPanel = autoSubs.length > 0 || manualEntries.length > 0;

    if (totalMins > 0) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'planner-daily-total-btn';
      btn.dataset.day = d;
      btn.textContent = fmtMins(totalMins);
      if (hasPanel) {
        btn.title = 'Ver desglose';
        btn.setAttribute('aria-expanded', 'false');
      }
      td.appendChild(btn);

      if (hasPanel) {
        const panel = document.createElement('div');
        panel.className = 'planner-subject-panel hidden';

        // Auto study rows (blue dot)
        const autoRows = autoSubs.map(s =>
          `<div class="planner-subject-row">` +
          `<span class="planner-subject-dot psr-auto"></span>` +
          `<span class="planner-subject-name">${escHtml(s.subject)}</span>` +
          `<span class="planner-subject-mins">${escHtml(fmtMins(s.minutes))}</span>` +
          `</div>`
        ).join('');

        // Manual activity rows (colored dot per type)
        const manualRows = manualEntries.map(m => {
          const info = MANUAL_ACTIVITY_TYPES[m.type] || { label: m.type, color: '#888' };
          const label = m.subject ? `${info.label} · ${m.subject}` : info.label;
          return `<div class="planner-subject-row">` +
            `<span class="planner-subject-dot" style="background:${escHtml(info.color)}"></span>` +
            `<span class="planner-subject-name">${escHtml(label)}</span>` +
            `<span class="planner-subject-mins">${escHtml(fmtMins(m.minutes))}</span>` +
            `</div>`;
        }).join('');

        panel.innerHTML = autoRows + manualRows;
        td.appendChild(panel);
      }
    } else {
      const empty = document.createElement('span');
      empty.className = 'planner-daily-total-empty';
      empty.textContent = '—';
      td.appendChild(empty);
    }

    tr.appendChild(td);
  }

  tfoot.appendChild(tr);
  table.appendChild(tfoot);

  tfoot.addEventListener('click', (e) => {
    const btn = e.target.closest('.planner-daily-total-btn');
    if (!btn) return;
    const cell  = btn.closest('.planner-daily-total-cell');
    const panel = cell?.querySelector('.planner-subject-panel');
    if (!panel) return;
    const opening = panel.classList.contains('hidden');
    tfoot.querySelectorAll('.planner-subject-panel:not(.hidden)').forEach(p => {
      p.classList.add('hidden');
      p.closest('.planner-daily-total-cell')
        ?.querySelector('.planner-daily-total-btn')
        ?.setAttribute('aria-expanded', 'false');
    });
    if (opening) {
      panel.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
    }
  });

  plannerState.totalsCloseHandler = (e) => {
    if (!e.target.closest('.planner-tfoot-totals')) {
      tfoot.querySelectorAll('.planner-subject-panel:not(.hidden)').forEach(p => {
        p.classList.add('hidden');
        p.closest('.planner-daily-total-cell')
          ?.querySelector('.planner-daily-total-btn')
          ?.setAttribute('aria-expanded', 'false');
      });
    }
  };
  document.addEventListener('click', plannerState.totalsCloseHandler);
}

function plannerCurrentSlotKey(now = new Date()) {
  const day = now.getDay();
  const hour = now.getHours();
  const minute = now.getMinutes();
  if (hour < 5 || hour >= 22) return null;
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
    const manualSlots = {};
    for (const row of (data.manual_slots || [])) {
      const key = `${row.day_index}_${row.slot_time}`;
      if (!manualSlots[key]) manualSlots[key] = [];
      manualSlots[key].push({
        activity_type:    row.activity_type,
        subject:          row.subject || null,
        duration_minutes: Number(row.duration_minutes || 0),
      });
    }
    plannerState.cells = cells;
    plannerState.activitySlots = activitySlots;
    plannerState.manualSlots   = manualSlots;
    document.querySelector('#planner-loading').classList.add('hidden');
    buildPlannerGrid(weekStart, cells, activitySlots, manualSlots);
    plannerMarkCurrentSlot();
    const table = document.querySelector('#planner-table');
    if (table) buildPlannerDailyTotals(table, activitySlots, data.daily_subject_totals || [], manualSlots);
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

  initManualActivityWidget();
  initActivityHistoryModal();
  initPlannerTodos();
}

// ─── Manual activity timer widget ─────────────────────────────────────────────
function initManualActivityWidget() {
  const openBtn       = document.querySelector('#pab-open-btn');
  const activeDisplay = document.querySelector('#pab-active-display');
  const activeLabel   = document.querySelector('#pab-active-label');
  const activeElapsed = document.querySelector('#pab-active-elapsed');
  const activeDot     = document.querySelector('#pab-active-dot');
  const stopBtn       = document.querySelector('#pab-stop-btn');
  const form          = document.querySelector('#pab-form');
  const typeBtns      = document.querySelectorAll('.pab-type-btn');
  const subjectInput  = document.querySelector('#pab-subject-input');
  const startBtn      = document.querySelector('#pab-start-btn');
  const cancelBtn     = document.querySelector('#pab-cancel-btn');
  const formError     = document.querySelector('#pab-form-error');
  const datalist      = document.querySelector('#pab-subjects-list');
  const customRow     = document.querySelector('#pab-custom-types-row');
  const addTypeBtn    = document.querySelector('#pab-add-type-btn');
  const addTypeInline = document.querySelector('#pab-add-type-inline');
  const newTypeInput  = document.querySelector('#pab-new-type-input');
  const newTypeSave   = document.querySelector('#pab-new-type-save');
  const newTypeCancel = document.querySelector('#pab-new-type-cancel');

  let selectedType  = null;
  let elapsedTimer  = null;
  let activeId      = null;
  let customTypes   = []; // [{ id, label, slug, color }]

  // Populate subject autocomplete
  getJson('/api/cards/subjects').then(res => {
    if (res.subjects && datalist) {
      datalist.innerHTML = res.subjects.map(s => `<option value="${escHtml(s)}">`).join('');
    }
  }).catch(() => {});

  function authHeaders(extra = {}) {
    const h = { ...extra };
    if (Auth.getToken()) h['Authorization'] = 'Bearer ' + Auth.getToken();
    return h;
  }

  function getTypeInfo(slug) {
    if (MANUAL_ACTIVITY_TYPES[slug]) return MANUAL_ACTIVITY_TYPES[slug];
    const ct = customTypes.find(t => t.slug === slug);
    if (ct) return { label: ct.label, color: ct.color };
    return { label: slug, color: '#888' };
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function selectType(slug) {
    selectedType = slug;
    // Deselect all built-in
    typeBtns.forEach(b => b.classList.remove('pab-type-btn--active'));
    // Deselect all custom
    customRow.querySelectorAll('.pab-custom-type-btn').forEach(b => {
      b.style.background = '';
      b.style.borderColor = '';
      b.style.color = '';
    });
    // Apply active state
    const builtInBtn = form.querySelector(`.pab-type-btn[data-type="${CSS.escape(slug)}"]`);
    if (builtInBtn) {
      builtInBtn.classList.add('pab-type-btn--active');
    } else {
      const customBtn = customRow.querySelector(`.pab-custom-type-btn[data-slug="${CSS.escape(slug)}"]`);
      if (customBtn) {
        const color = customBtn.dataset.color || '#888';
        customBtn.style.background = hexToRgba(color, 0.18);
        customBtn.style.borderColor = color;
        customBtn.style.color = color;
      }
    }
    startBtn.disabled = false;
  }

  function renderCustomTypes() {
    // Remove existing custom type buttons (keep addTypeInline and addTypeBtn)
    customRow.querySelectorAll('.pab-custom-type-btn').forEach(b => b.remove());
    // Re-insert before addTypeBtn
    for (const ct of customTypes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pab-custom-type-btn';
      btn.dataset.slug = ct.slug;
      btn.dataset.color = ct.color;
      btn.innerHTML = `${escHtml(ct.label)}<span class="pab-custom-type-del" data-id="${ct.id}" title="Eliminar tipo">&#215;</span>`;
      customRow.insertBefore(btn, addTypeBtn);
    }
  }

  async function loadCustomTypes() {
    try {
      const res = await fetch('/planner/manual-activity/custom-types', { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      customTypes = data.types || [];
      renderCustomTypes();
    } catch (_) {}
  }

  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  function startElapsedTimer(startedAt) {
    if (elapsedTimer) clearInterval(elapsedTimer);
    const origin = new Date(startedAt).getTime();
    const tick = () => { activeElapsed.textContent = fmtElapsed(Date.now() - origin); };
    tick();
    elapsedTimer = setInterval(tick, 1000);
  }

  function showActive(id, type, subject, startedAt) {
    activeId = id;
    const info = getTypeInfo(type);
    activeDot.style.background = info.color;
    activeLabel.textContent = subject ? `${info.label} · ${subject}` : info.label;
    document.querySelector('#pab-idle').classList.add('hidden');
    activeDisplay.classList.remove('hidden');
    form.classList.add('hidden');
    startElapsedTimer(startedAt);
  }

  function clearActive() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    activeId = null;
    document.querySelector('#pab-idle').classList.remove('hidden');
    activeDisplay.classList.add('hidden');
    localStorage.removeItem(MANUAL_ACTIVITY_PERSIST_KEY);
  }

  // Check for a running session on init
  (async () => {
    await loadCustomTypes();
    try {
      const res = await fetch('/planner/manual-activity/active', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (data.session) showActive(data.session.id, data.session.activity_type, data.session.subject, data.session.started_at);
      }
    } catch (_) {}
  })();

  openBtn.addEventListener('click', () => {
    form.classList.remove('hidden');
    document.querySelector('#pab-idle').classList.add('hidden');
    formError.classList.add('hidden');
  });

  cancelBtn.addEventListener('click', () => {
    form.classList.add('hidden');
    document.querySelector('#pab-idle').classList.remove('hidden');
    selectedType = null;
    typeBtns.forEach(b => b.classList.remove('pab-type-btn--active'));
    customRow.querySelectorAll('.pab-custom-type-btn').forEach(b => {
      b.style.background = '';
      b.style.borderColor = '';
      b.style.color = '';
    });
    startBtn.disabled = true;
    addTypeInline.classList.add('hidden');
    addTypeBtn.classList.remove('hidden');
    newTypeInput.value = '';
  });

  // Built-in type selection
  typeBtns.forEach(btn => {
    btn.addEventListener('click', () => selectType(btn.dataset.type));
  });

  // Custom type selection + delete (event delegation on customRow)
  customRow.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.pab-custom-type-del');
    if (delBtn) {
      e.stopPropagation();
      const typeId = parseInt(delBtn.dataset.id, 10);
      (async () => {
        try {
          const res = await fetch(`/planner/manual-activity/custom-types/${typeId}`, {
            method: 'DELETE',
            headers: authHeaders(),
          });
          if (res.ok) {
            customTypes = customTypes.filter(t => t.id !== typeId);
            if (selectedType === delBtn.closest('.pab-custom-type-btn')?.dataset.slug) {
              selectedType = null;
              startBtn.disabled = true;
            }
            renderCustomTypes();
          }
        } catch (_) {}
      })();
      return;
    }
    const customBtn = e.target.closest('.pab-custom-type-btn');
    if (customBtn) selectType(customBtn.dataset.slug);
  });

  // Show "add type" inline input
  addTypeBtn.addEventListener('click', () => {
    addTypeBtn.classList.add('hidden');
    addTypeInline.classList.remove('hidden');
    newTypeInput.focus();
  });

  newTypeCancel.addEventListener('click', () => {
    addTypeInline.classList.add('hidden');
    addTypeBtn.classList.remove('hidden');
    newTypeInput.value = '';
  });

  async function saveNewCustomType() {
    const label = newTypeInput.value.trim();
    if (!label) return;
    newTypeSave.disabled = true;
    try {
      const res = await fetch('/planner/manual-activity/custom-types', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ label }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      // Avoid duplicates in local list
      customTypes = customTypes.filter(t => t.id !== data.type.id);
      customTypes.push(data.type);
      renderCustomTypes();
      newTypeInput.value = '';
      addTypeInline.classList.add('hidden');
      addTypeBtn.classList.remove('hidden');
      selectType(data.type.slug);
    } catch (err) {
      newTypeInput.style.borderColor = 'var(--fail-fg)';
      setTimeout(() => { newTypeInput.style.borderColor = ''; }, 1500);
    } finally {
      newTypeSave.disabled = false;
    }
  }

  newTypeSave.addEventListener('click', saveNewCustomType);
  newTypeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNewCustomType();
    if (e.key === 'Escape') newTypeCancel.click();
  });

  startBtn.addEventListener('click', async () => {
    if (!selectedType) return;
    const subject = subjectInput.value.trim() || null;
    startBtn.disabled = true;
    formError.classList.add('hidden');
    try {
      const res = await fetch('/planner/manual-activity', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ activity_type: selectedType, subject }),
      });
      Auth.handleRefreshToken(res);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      selectedType = null;
      typeBtns.forEach(b => b.classList.remove('pab-type-btn--active'));
      customRow.querySelectorAll('.pab-custom-type-btn').forEach(b => {
        b.style.background = '';
        b.style.borderColor = '';
        b.style.color = '';
      });
      subjectInput.value = '';
      showActive(data.session.id, data.session.activity_type, data.session.subject, data.session.started_at);
    } catch (err) {
      formError.textContent = err.message;
      formError.classList.remove('hidden');
      startBtn.disabled = false;
    }
  });

  stopBtn.addEventListener('click', async () => {
    if (!activeId) return;
    stopBtn.disabled = true;
    try {
      const res = await fetch(`/planner/manual-activity/${activeId}/stop`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
      });
      Auth.handleRefreshToken(res);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.message || `HTTP ${res.status}`);
      }
      clearActive();
      if (plannerState.weekStart) loadPlannerWeek(plannerState.weekStart);
    } catch (_) {
      stopBtn.disabled = false;
    }
  });
}

// ─── Activity History Modal ────────────────────────────────────────────────────
function initActivityHistoryModal() {
  const modal       = document.querySelector('#pab-history-modal');
  const backdrop    = modal.querySelector('.pab-history-backdrop');
  const closeBtn    = document.querySelector('#pab-history-close');
  const historyBtn  = document.querySelector('#pab-history-btn');
  const loadingEl   = document.querySelector('#pab-history-loading');
  const listEl      = document.querySelector('#pab-history-list');
  const emptyEl     = document.querySelector('#pab-history-empty');

  const editModal   = document.querySelector('#pab-edit-modal');
  const editClose   = document.querySelector('#pab-edit-close');
  const editCancel  = document.querySelector('#pab-edit-cancel');
  const editSave    = document.querySelector('#pab-edit-save');
  const editStart   = document.querySelector('#pab-edit-start');
  const editEnd     = document.querySelector('#pab-edit-end');
  const editError   = document.querySelector('#pab-edit-error');
  const editBackdrop = editModal.querySelector('.pab-edit-backdrop');

  let editingId = null;

  function authH(extra = {}) {
    const h = { ...extra };
    if (Auth.getToken()) h['Authorization'] = 'Bearer ' + Auth.getToken();
    return h;
  }

  function toLocalDatetimeValue(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtDate(isoStr) {
    if (!isoStr) return '?';
    return new Date(isoStr).toLocaleString('es-AR', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function fmtDur(mins) {
    if (mins == null || isNaN(mins)) return '?';
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }

  function getTypeInfo(slug) {
    if (MANUAL_ACTIVITY_TYPES[slug]) return MANUAL_ACTIVITY_TYPES[slug];
    return { label: slug, color: '#888' };
  }

  function renderList(sessions) {
    listEl.innerHTML = '';
    if (!sessions.length) {
      emptyEl.classList.remove('hidden');
      listEl.classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.classList.remove('hidden');

    for (const s of sessions) {
      const info = getTypeInfo(s.activity_type);
      const li = document.createElement('li');
      li.className = 'pab-history-item';
      li.dataset.id = s.id;

      const dot = document.createElement('span');
      dot.className = 'pab-hi-dot';
      dot.style.background = info.color;

      const infoDiv = document.createElement('div');
      infoDiv.className = 'pab-hi-info';
      infoDiv.innerHTML = `
        <div>
          <span class="pab-hi-type">${escHtml(info.label)}</span>
          ${s.subject ? `<span class="pab-hi-subject"> · ${escHtml(s.subject)}</span>` : ''}
        </div>
        <div class="pab-hi-meta">${escHtml(fmtDate(s.started_at))} &ndash; ${escHtml(fmtDate(s.ended_at))} &nbsp;|&nbsp; ${escHtml(fmtDur(s.duration_minutes))}</div>
      `.trim();

      const actions = document.createElement('div');
      actions.className = 'pab-hi-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'pab-hi-edit-btn';
      editBtn.textContent = 'Editar';
      editBtn.addEventListener('click', () => openEditModal(s));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pab-hi-del-btn';
      delBtn.textContent = 'Eliminar';
      delBtn.addEventListener('click', () => deleteSession(s.id, li));

      actions.append(editBtn, delBtn);
      li.append(dot, infoDiv, actions);
      listEl.appendChild(li);
    }
  }

  async function loadHistory() {
    loadingEl.classList.remove('hidden');
    listEl.classList.add('hidden');
    emptyEl.classList.add('hidden');
    try {
      const res = await fetch('/planner/manual-activity/recent?limit=30', { headers: authH() });
      Auth.handleRefreshToken(res);
      const data = await res.json().catch(() => ({}));
      renderList(data.sessions || []);
    } catch (_) {
      loadingEl.textContent = 'Error al cargar.';
      return;
    }
    loadingEl.classList.add('hidden');
  }

  function openModal() {
    modal.classList.remove('hidden');
    loadHistory();
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  historyBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!editModal.classList.contains('hidden')) { closeEditModal(); return; }
      if (!modal.classList.contains('hidden')) { closeModal(); }
    }
  });

  // ── Edit modal ──
  function openEditModal(session) {
    editingId = session.id;
    editStart.value = toLocalDatetimeValue(session.started_at);
    editEnd.value   = toLocalDatetimeValue(session.ended_at);
    editError.classList.add('hidden');
    editSave.disabled = false;
    editModal.classList.remove('hidden');
    editStart.focus();
  }

  function closeEditModal() {
    editModal.classList.add('hidden');
    editingId = null;
  }

  editClose.addEventListener('click', closeEditModal);
  editCancel.addEventListener('click', closeEditModal);
  editBackdrop.addEventListener('click', closeEditModal);

  editSave.addEventListener('click', async () => {
    if (!editingId) return;
    const startVal = editStart.value;
    const endVal   = editEnd.value;
    if (!startVal || !endVal) {
      editError.textContent = 'Completá ambos campos.';
      editError.classList.remove('hidden');
      return;
    }

    const startDate = new Date(startVal);
    const endDate   = new Date(endVal);
    if (endDate <= startDate) {
      editError.textContent = 'El fin debe ser posterior al inicio.';
      editError.classList.remove('hidden');
      return;
    }

    editSave.disabled = true;
    editError.classList.add('hidden');
    try {
      const res = await fetch(`/planner/manual-activity/${editingId}`, {
        method: 'PATCH',
        headers: authH({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ started_at: startDate.toISOString(), ended_at: endDate.toISOString() }),
      });
      Auth.handleRefreshToken(res);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      closeEditModal();
      loadHistory();
      if (plannerState.weekStart) loadPlannerWeek(plannerState.weekStart);
    } catch (err) {
      editError.textContent = err.message;
      editError.classList.remove('hidden');
      editSave.disabled = false;
    }
  });

  // ── Delete ──
  async function deleteSession(id, liEl) {
    if (!confirm('¿Eliminar esta actividad?')) return;
    try {
      const res = await fetch(`/planner/manual-activity/${id}`, {
        method: 'DELETE',
        headers: authH(),
      });
      Auth.handleRefreshToken(res);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.message || `Error ${res.status}`, 'error');
        return;
      }
      liEl.remove();
      if (!listEl.children.length) {
        listEl.classList.add('hidden');
        emptyEl.classList.remove('hidden');
      }
      if (plannerState.weekStart) loadPlannerWeek(plannerState.weekStart);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
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
    await postJson(`/planner/todos/${todo.id}`, { done }, 'PATCH').catch((err) => {
      check.checked = !done;
      li.classList.toggle('done', !done);
      console.warn('[planner] Failed to update todo:', err.message);
    });
  });

  const textEl = document.createElement('input');
  textEl.type = 'text';
  textEl.className = 'planner-todo-text';
  textEl.value = todo.text;
  textEl.addEventListener('blur', async () => {
    const text = textEl.value.trim();
    if (!text) { textEl.value = todo.text; return; }
    if (text === todo.text) return;
    const prev = todo.text;
    todo.text = text;
    await postJson(`/planner/todos/${todo.id}`, { text }, 'PATCH').catch((err) => {
      todo.text = prev;
      textEl.value = prev;
      console.warn('[planner] Failed to update todo text:', err.message);
    });
  });
  textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') textEl.blur(); });

  const del = document.createElement('button');
  del.className = 'planner-todo-delete';
  del.textContent = '✕';
  del.title = 'Eliminar';
  del.addEventListener('click', async () => {
    await deleteJson(`/planner/todos/${todo.id}`).catch((err) => {
      console.warn('[planner] Failed to delete todo:', err.message);
    });
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
              showToast('Ingresá un motivo de al menos 5 caracteres.', 'error');
              return;
            }

            deleteBtn.disabled = true;
            deleteBtn.textContent = 'Eliminando...';
            try {
              await postJson(`/cards/${card.id}/archive`, { reason }, 'PATCH');
              await loadAgenda();
            } catch (err) {
              showToast(`No se pudo eliminar la tarjeta: ${err.message}`, 'error');
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

const STRICTNESS_LEVELS = [
  { max: 2,  name: 'Básica',    desc: 'Muy generosa. Si entendiste la idea, es GOOD.' },
  { max: 4,  name: 'Moderada',  desc: 'Generosa. Detalles menores no se penalizan.' },
  { max: 6,  name: 'Estándar',  desc: 'Equilibrada. Todos los elementos esenciales requeridos.' },
  { max: 8,  name: 'Exigente',  desc: 'Estricta. Precisión técnica y vocabulario exacto requeridos.' },
  { max: 10, name: 'Máxima',    desc: 'Implacable. Ante la duda, baja la nota. Busca fallas activamente.' }
];

function updateStrictnessDisplay(value) {
  const n = parseInt(value, 10);
  const level = STRICTNESS_LEVELS.find((l) => n <= l.max) || STRICTNESS_LEVELS[STRICTNESS_LEVELS.length - 1];
  const badge = document.querySelector('#curriculum-strictness-badge');
  const desc  = document.querySelector('#curriculum-strictness-desc');
  if (!badge || !desc) return;
  badge.textContent = `${level.name} (${n}/10)`;
  badge.dataset.level = level.name.toLowerCase();
  desc.textContent = level.desc;
}

document.querySelector('#curriculum-grading-strictness')?.addEventListener('input', (e) => {
  updateStrictnessDisplay(e.target.value);
});

document.querySelector('#curriculum-retention-floor')?.addEventListener('input', (e) => {
  document.querySelector('#curriculum-retention-floor-badge').textContent = `${e.target.value}%`;
});

function updateMicroCardsLimitVisibility(enabled) {
  const limitRow  = document.querySelector('#micro-cards-limit-row');
  const spawnRow  = document.querySelector('#micro-spawn-row');
  if (limitRow) limitRow.style.display = enabled ? '' : 'none';
  if (spawnRow) spawnRow.style.display  = enabled ? '' : 'none';
}

document.querySelector('#curriculum-micro-cards-enabled')?.addEventListener('change', (e) => {
  updateMicroCardsLimitVisibility(e.target.checked);
});

document.querySelector('#curriculum-auto-variants-enabled')?.addEventListener('change', (e) => {
  document.querySelector('#auto-variants-limit-row').style.display = e.target.checked ? '' : 'none';
});

async function openCurriculumModal(subject) {
  document.querySelector('#curriculum-modal-title').textContent = `Configurar: ${subject}`;
  document.querySelector('#curriculum-modal').classList.remove('hidden');

  // Load existing config + class notes + sql standard
  try {
    const [data, classNotesData] = await Promise.all([
      getJson(`/curriculum/${encodeURIComponent(subject)}`),
      getJson(`/curriculum/${encodeURIComponent(subject)}/class-notes`)
    ]);
    loadSqlStandard(subject);
    document.querySelector('#curriculum-syllabus').value = data.config?.syllabus_text || '';
    document.querySelector('#curriculum-daily-new-limit').value = data.config?.daily_new_cards_limit ?? '';
    document.querySelector('#curriculum-max-micro-per-card').value = data.config?.max_micro_cards_per_card ?? '';
    const strictness = data.config?.grading_strictness ?? userSettings.default_grading_strictness ?? 5;
    document.querySelector('#curriculum-grading-strictness').value = strictness;
    updateStrictnessDisplay(strictness);
    const retFloor = data.config?.retention_floor != null
      ? Math.round(parseFloat(data.config.retention_floor) * 100)
      : (userSettings.default_retention_floor ?? 75);
    document.querySelector('#curriculum-retention-floor').value = retFloor;
    document.querySelector('#curriculum-retention-floor-badge').textContent = `${retFloor}%`;
    const microEnabled = data.config?.micro_cards_enabled ?? true;
    document.querySelector('#curriculum-micro-cards-enabled').checked = microEnabled;
    document.querySelector('#curriculum-micro-spawn-siblings').checked = data.config?.micro_cards_spawn_siblings ?? false;
    updateMicroCardsLimitVisibility(microEnabled);
    const autoVariants = data.config?.auto_variants_enabled ?? false;
    document.querySelector('#curriculum-auto-variants-enabled').checked = autoVariants;
    document.querySelector('#curriculum-max-variants-per-card').value = data.config?.max_variants_per_card ?? '';
    document.querySelector('#auto-variants-limit-row').style.display = autoVariants ? '' : 'none';
    renderExamDatesList(data.exam_dates || [], subject);
    renderExamsList(data.exams || [], subject);
    renderClassNotesList(classNotesData.class_notes || [], subject);
  } catch (_e) {
    document.querySelector('#curriculum-daily-new-limit').value = '';
    document.querySelector('#curriculum-max-micro-per-card').value = '';
    const defStrictness = userSettings.default_grading_strictness ?? 5;
    document.querySelector('#curriculum-grading-strictness').value = defStrictness;
    updateStrictnessDisplay(defStrictness);
    const defRetFloor = userSettings.default_retention_floor ?? 75;
    document.querySelector('#curriculum-retention-floor').value = defRetFloor;
    document.querySelector('#curriculum-retention-floor-badge').textContent = `${defRetFloor}%`;
    document.querySelector('#curriculum-micro-cards-enabled').checked = true;
    document.querySelector('#curriculum-micro-spawn-siblings').checked = false;
    updateMicroCardsLimitVisibility(true);
    document.querySelector('#curriculum-auto-variants-enabled').checked = false;
    document.querySelector('#curriculum-max-variants-per-card').value = '';
    document.querySelector('#auto-variants-limit-row').style.display = 'none';
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
  const rawDailyLimit = document.querySelector('#curriculum-daily-new-limit').value.trim();
  const parsedDailyLimit = rawDailyLimit === '' ? null : parseInt(rawDailyLimit, 10);

  if (rawDailyLimit !== '' && (!Number.isFinite(parsedDailyLimit) || parsedDailyLimit < 0)) {
    showToast('El límite diario debe ser un entero mayor o igual a 0.', 'error');
    return;
  }

  const rawMicroLimit = document.querySelector('#curriculum-max-micro-per-card').value.trim();
  const parsedMicroLimit = rawMicroLimit === '' ? null : parseInt(rawMicroLimit, 10);

  if (rawMicroLimit !== '' && (!Number.isFinite(parsedMicroLimit) || parsedMicroLimit < 0)) {
    showToast('El límite de micro-tarjetas debe ser un entero mayor o igual a 0.', 'error');
    return;
  }

  try {
    const strictness       = parseInt(document.querySelector('#curriculum-grading-strictness').value, 10);
    const microEnabled     = document.querySelector('#curriculum-micro-cards-enabled').checked;
    const spawnSiblings    = document.querySelector('#curriculum-micro-spawn-siblings').checked;
    const autoVariants     = document.querySelector('#curriculum-auto-variants-enabled').checked;
    const rawMaxVariants   = document.querySelector('#curriculum-max-variants-per-card').value.trim();
    const parsedMaxVariants = rawMaxVariants === '' ? null : parseInt(rawMaxVariants, 10);
    if (rawMaxVariants !== '' && (!Number.isFinite(parsedMaxVariants) || parsedMaxVariants < 1)) {
      showToast('El máximo de variantes debe ser un entero mayor o igual a 1.', 'error');
      return;
    }
    const retFloorRaw = parseInt(document.querySelector('#curriculum-retention-floor').value, 10);
    const retFloorVal = Number.isFinite(retFloorRaw) ? Math.min(99, Math.max(50, retFloorRaw)) / 100 : 0.75;
    await postJson(`/curriculum/${encodeURIComponent(subject)}`, {
      syllabus_text:                document.querySelector('#curriculum-syllabus').value,
      daily_new_cards_limit:        parsedDailyLimit,
      max_micro_cards_per_card:     parsedMicroLimit,
      grading_strictness:           Number.isFinite(strictness) ? strictness : 5,
      micro_cards_enabled:          microEnabled,
      micro_cards_spawn_siblings:   spawnSiblings,
      auto_variants_enabled:        autoVariants,
      max_variants_per_card:        parsedMaxVariants,
      retention_floor:              retFloorVal
    }, 'PUT');
    showToast('Configuración guardada.', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

// ── GitHub import ─────────────────────────────────────────────────────────────

document.querySelector('#github-import-btn').addEventListener('click', async () => {
  const subject = document.querySelector('#curriculum-modal').dataset.subject;
  const url     = (document.querySelector('#github-repo-url').value || '').trim();
  const btn     = document.querySelector('#github-import-btn');

  if (!url) {
    showToast('Pegá una URL de GitHub.', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Importando...';

  try {
    const data = await postJson('/import/github', { repo_url: url, subject });
    const n = data.cards_created;
    showToast(`${n} tarjeta${n !== 1 ? 's' : ''} creada${n !== 1 ? 's' : ''}. Aparecerán en tu cola de estudio.`, 'success');
    document.querySelector('#github-repo-url').value = '';
  } catch (err) {
    showToast(`Error al importar: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Importar';
  }
});

// ── Exam dates (múltiples por materia) ────────────────────────────────────────

document.querySelector('#exam-date-add-btn').addEventListener('click', async () => {
  const subject = document.querySelector('#curriculum-modal').dataset.subject;
  const label = document.querySelector('#new-exam-label').value.trim();
  const date  = document.querySelector('#new-exam-date').value;
  const type  = document.querySelector('#new-exam-type').value;
  const scope = parseInt(document.querySelector('#new-exam-scope').value, 10);

  if (!label) { showToast('El nombre del examen es obligatorio.', 'error'); return; }
  if (!date)  { showToast('La fecha es obligatoria.', 'error'); return; }
  if (!scope || scope < 1 || scope > 100) { showToast('El % debe ser entre 1 y 100.', 'error'); return; }

  try {
    const data = await postJson(`/curriculum/${encodeURIComponent(subject)}/exam-dates`, {
      label, exam_date: date, exam_type: type, scope_pct: scope
    });
    showToast('Fecha de examen agregada.', 'success');
    document.querySelector('#new-exam-label').value = '';
    document.querySelector('#new-exam-date').value  = '';
    document.querySelector('#new-exam-scope').value = '50';
    renderExamDatesList(data.exam_dates, subject);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
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
  const content = document.querySelector('#exam-content').value.trim();
  if (!content) { showToast('El contenido es obligatorio.', 'error'); return; }
  try {
    const data = await postJson(`/curriculum/${encodeURIComponent(subject)}/exams`, {
      year: parseInt(document.querySelector('#exam-year').value) || null,
      label: document.querySelector('#exam-label').value.trim() || null,
      exam_type: document.querySelector('#exam-type-select').value,
      content_text: content
    });
    showToast('Examen de referencia agregado.', 'success');
    document.querySelector('#exam-content').value = '';
    document.querySelector('#exam-year').value = '';
    document.querySelector('#exam-label').value = '';
    renderExamsList(data.exams, subject);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

function renderExamsList(exams, subject) {
  const el = document.querySelector('#curriculum-exams-list');
  if (!exams.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">Sin exámenes de referencia.</p>'; return; }
  el.innerHTML = exams.map(e => `
    <div class="ref-exam-item" style="border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0">
        <span style="flex:1;font-size:0.85rem;font-weight:600">${escHtml(e.label || e.exam_type)} ${e.year ? escHtml(String(e.year)) : ''}</span>
        <button type="button" class="btn-ghost ref-exam-toggle-btn" style="font-size:0.72rem;padding:1px 7px">Ver</button>
        <button type="button" class="btn-ghost exam-delete-btn" data-id="${e.id}" data-subject="${escHtml(subject)}" style="font-size:0.75rem;padding:2px 8px">Eliminar</button>
      </div>
      <div class="ref-exam-body hidden" style="padding:0 0 8px;font-size:0.8rem;white-space:pre-wrap;color:var(--text);line-height:1.5">${escHtml(e.content_text || '')}</div>
    </div>`).join('');

  el.querySelectorAll('.ref-exam-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = btn.closest('.ref-exam-item').querySelector('.ref-exam-body');
      const opening = body.classList.contains('hidden');
      body.classList.toggle('hidden', !opening);
      btn.textContent = opening ? 'Ocultar' : 'Ver';
    });
  });

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

// ── SQL Standard ──────────────────────────────────────────────────────────────

function renderSqlRules(rules) {
  const list = document.querySelector('#sql-standard-rules-list');
  if (!list) return;
  if (!rules || !rules.length) {
    list.innerHTML = '';
    return;
  }
  const severityColor = { error: 'var(--fail-fg)', warning: 'var(--text-muted)' };
  const categoryLabel = { naming: 'Nombres', formatting: 'Formato', style: 'Estilo', structure: 'Estructura', forbidden: 'Prohibido' };
  list.innerHTML = `
    <p style="font-size:0.8rem;font-weight:600;margin:0 0 6px">${rules.length} regla${rules.length !== 1 ? 's' : ''} extraída${rules.length !== 1 ? 's' : ''}:</p>
    ${rules.map(r => `
      <div style="border-left:3px solid ${severityColor[r.severity] || 'var(--text-muted)'};padding:4px 8px;margin-bottom:6px;font-size:0.8rem">
        <span style="color:var(--text-muted);font-size:0.72rem">${categoryLabel[r.category] || r.category} · ${r.severity}</span><br>
        <span>${escHtml(r.description)}</span>
        ${r.source_quote ? `<br><em style="color:var(--text-muted);font-size:0.75rem">"${escHtml(r.source_quote)}"</em>` : ''}
      </div>`).join('')}`;
}

function renderSqlValidationResults(results) {
  const el = document.querySelector('#sql-standard-results');
  if (!el || !results) return;
  const nonCompliant = results.filter(r => !r.compliant);
  const compliant = results.filter(r => r.compliant);
  el.innerHTML = `
    <p style="font-size:0.8rem;font-weight:600;margin:0 0 6px">
      Resultados: <span style="color:var(--fail-fg)">${nonCompliant.length} no cumplen</span> · <span style="color:var(--pass-fg)">${compliant.length} cumplen</span>
    </p>
    ${nonCompliant.map(r => `
      <div class="sql-violation-card" data-card-id="${r.card_id}" style="border-left:3px solid var(--fail-fg);padding:4px 8px;margin-bottom:5px;font-size:0.79rem">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:3px;flex-wrap:wrap">
          <strong style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.prompt_text?.slice(0, 80) || 'Tarjeta')}</strong>
          <div style="display:flex;gap:4px;flex-shrink:0">
            <button class="btn-ghost sql-violation-view-btn" data-card-id="${r.card_id}" style="font-size:0.72rem;padding:1px 6px">Ver tarjeta</button>
            <button class="btn-ghost sql-violation-ai-fix-btn" data-card-id="${r.card_id}" style="font-size:0.72rem;padding:1px 6px">Corregir con IA</button>
          </div>
        </div>
        ${r.violations.map(v => `<span style="color:var(--fail-fg)">• ${escHtml(v.description)}</span>`).join('<br>')}
      </div>`).join('')}`;

  el.querySelectorAll('.sql-violation-view-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cardId = btn.dataset.cardId;
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const data = await getJson(`/cards/${cardId}`);
        if (data.card) showCardDetail(data.card);
        else btn.textContent = 'No encontrada';
      } catch (_) {
        btn.textContent = 'Error';
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 1500);
      }
    });
  });

  el.querySelectorAll('.sql-violation-ai-fix-btn').forEach(btn => {
    btn.addEventListener('click', () => openAiFixPanel(btn));
  });
}

async function openAiFixPanel(triggerBtn) {
  const cardId = triggerBtn.dataset.cardId;
  const cardRow = triggerBtn.closest('.sql-violation-card');
  if (!cardRow) return;

  // Toggle: close if already open
  const existing = cardRow.querySelector('.ai-fix-panel');
  if (existing) { existing.remove(); return; }

  triggerBtn.disabled = true;
  triggerBtn.textContent = 'Consultando IA...';

  const panel = document.createElement('div');
  panel.className = 'ai-fix-panel';
  panel.style.cssText = 'margin-top:8px;padding:10px 12px;border:1px solid var(--border-mid);border-radius:6px;background:var(--bg-subtle);font-size:0.8rem';

  try {
    const data = await postJson(`/cards/${cardId}/ai-fix-answer`, {});
    const suggested = data.suggested_answer || '';

    const label = document.createElement('div');
    label.style.cssText = 'font-weight:600;margin-bottom:6px;color:var(--text-muted);font-size:0.75rem;text-transform:uppercase;letter-spacing:.04em';
    label.textContent = 'Corrección sugerida por IA:';

    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;background:var(--bg-code,#1e1e1e);color:var(--fg-code,#d4d4d4);padding:10px;border-radius:4px;font-size:0.8rem;max-height:260px;overflow-y:auto;margin:0 0 8px';
    pre.textContent = suggested;

    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display:flex;gap:8px;align-items:center';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn-secondary';
    confirmBtn.style.fontSize = '0.82rem';
    confirmBtn.textContent = 'Confirmar y guardar';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-ghost';
    cancelBtn.style.fontSize = '0.82rem';
    cancelBtn.textContent = 'Cancelar';

    const fb = document.createElement('span');
    fb.style.cssText = 'font-size:0.78rem;margin-left:4px';

    actionsRow.append(confirmBtn, cancelBtn, fb);
    panel.append(label, pre, actionsRow);
    cardRow.appendChild(panel);

    cancelBtn.addEventListener('click', () => panel.remove());

    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Guardando...';
      fb.textContent = '';
      try {
        const result = await postJson('/cards/batch', { action: 'edit', ids: [Number(cardId)], expected_answer_text: suggested });
        if (!result?.updated) throw new Error('La tarjeta no se actualizó en la base de datos.');
        fb.textContent = '✓ Guardado';
        fb.style.color = 'var(--pass-fg)';
        confirmBtn.textContent = 'Guardado';
        cardRow.style.borderLeftColor = 'var(--pass-fg)';
        setTimeout(() => panel.remove(), 1800);
      } catch (_) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirmar y guardar';
        fb.textContent = 'Error al guardar.';
        fb.style.color = 'var(--fail-fg)';
      }
    });
  } catch (err) {
    panel.textContent = `Error: ${err.message || 'No se pudo obtener la corrección.'}`;
    panel.style.color = 'var(--fail-fg)';
    cardRow.appendChild(panel);
  } finally {
    triggerBtn.disabled = false;
    triggerBtn.textContent = 'Corregir con IA';
  }
}

async function loadSqlStandard(subject) {
  const statusEl = document.querySelector('#sql-standard-status');
  const fb = document.querySelector('#sql-standard-feedback');
  if (!statusEl) return;
  try {
    const data = await getJson(`/sql-standard/${encodeURIComponent(subject)}`);
    if (data.standard) {
      statusEl.textContent = `Estándar activo: ${data.standard.rules.length} regla${data.standard.rules.length !== 1 ? 's' : ''}`;
      statusEl.style.color = 'var(--pass-fg)';
      renderSqlRules(data.standard.rules);
    } else {
      statusEl.textContent = 'Sin estándar cargado.';
      statusEl.style.color = 'var(--text-muted)';
      renderSqlRules([]);
    }
  } catch (_e) {
    statusEl.textContent = 'Error al cargar estándar.';
  }

  // Wire buttons (replace to avoid duplicate listeners)
  function rewire(id, handler) {
    const btn = document.querySelector(`#${id}`);
    if (!btn) return;
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener('click', handler);
  }

  rewire('sql-standard-extract-btn', async () => {
    const input = document.querySelector('#sql-standard-input')?.value?.trim();
    if (!input) { showToast('Pegá material del profesor antes de extraer.', 'error'); return; }
    try {
      const data = await postJson(`/sql-standard/${encodeURIComponent(subject)}/extract`, { transcript_text: input });
      showToast(`Estándar extraído: ${data.standard.rules.length} reglas.${data.summary ? ' ' + data.summary : ''}`, 'success');
      statusEl.textContent = `Estándar activo: ${data.standard.rules.length} regla${data.standard.rules.length !== 1 ? 's' : ''}`;
      statusEl.style.color = 'var(--pass-fg)';
      renderSqlRules(data.standard.rules);
    } catch (err) {
      showToast('Error al extraer estándar.', 'error');
    }
  });

  rewire('sql-standard-validate-btn', async () => {
    try {
      const data = await postJson(`/sql-standard/${encodeURIComponent(subject)}/validate-batch`, {});
      showToast(`Validadas: ${data.validated} · Omitidas: ${data.skipped} · Errores: ${data.errors}`, 'success');
      const resultsData = await getJson(`/sql-standard/${encodeURIComponent(subject)}/results`);
      renderSqlValidationResults(resultsData.results || []);
    } catch (err) {
      showToast(err.message?.includes('estándar') ? 'Primero extraé un estándar.' : 'Error al validar tarjetas.', 'error');
    }
  });

  rewire('sql-standard-delete-btn', async () => {
    if (!confirm('¿Eliminar el estándar y todos los resultados de validación?')) return;
    try {
      await deleteJson(`/sql-standard/${encodeURIComponent(subject)}`);
      statusEl.textContent = 'Sin estándar cargado.';
      statusEl.style.color = 'var(--text-muted)';
      renderSqlRules([]);
      document.querySelector('#sql-standard-results').innerHTML = '';
      showToast('Estándar eliminado.', 'success');
    } catch (_e) {
      showToast('Error al eliminar estándar.', 'error');
    }
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

function renderStructuredNote(structuredData, container) {
  if (!structuredData || !structuredData.clusters) { container.innerHTML = ''; return; }
  const importanceBadge = (n) => {
    const colors = ['', '#aaa', '#888', 'var(--text-muted)', 'var(--pass-fg)', 'var(--fail-fg)'];
    const labels = ['', 'Mencionado', 'Explicado', 'Central', 'Evaluable', 'Crítico'];
    return `<span style="color:${colors[n] || '#aaa'};font-size:0.72rem;font-weight:600">${labels[n] || n}</span>`;
  };
  const examBadge = (r) => {
    const map = { high: ['var(--fail-fg)', 'Cae en examen'], medium: ['var(--pass-fg)', 'Relacionado'], low: ['var(--text-muted)', 'No aparece'] };
    const [col, label] = map[r] || ['var(--text-muted)', ''];
    return label ? `<span style="color:${col};font-size:0.7rem;margin-left:6px">${label}</span>` : '';
  };
  container.innerHTML = `
    ${structuredData.raw_summary ? `<p style="font-size:0.82rem;color:var(--text-muted);margin:0 0 10px;font-style:italic">${escHtml(structuredData.raw_summary)}</p>` : ''}
    ${structuredData.professor_emphasis?.length ? `<div style="margin-bottom:10px;font-size:0.78rem"><strong>El profe enfatizó:</strong> ${structuredData.professor_emphasis.map(e => `<em>"${escHtml(e)}"</em>`).join(' · ')}</div>` : ''}
    ${(structuredData.clusters || []).map(c => `
      <div style="border-left:3px solid ${c.importance >= 4 ? 'var(--fail-fg)' : c.importance >= 3 ? 'var(--pass-fg)' : 'var(--text-muted)'};padding:5px 10px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <strong style="font-size:0.85rem">${escHtml(c.concept)}</strong>
          ${importanceBadge(c.importance)}
          ${examBadge(c.exam_relevance)}
          ${c.mentions > 1 ? `<span style="color:var(--text-muted);font-size:0.7rem">${c.mentions} menciones</span>` : ''}
        </div>
        ${c.importance_reason ? `<p style="font-size:0.75rem;color:var(--text-muted);margin:2px 0">${escHtml(c.importance_reason)}</p>` : ''}
        <p style="font-size:0.8rem;margin:4px 0">${escHtml(c.summary || '')}</p>
        ${c.key_points?.length ? `<ul style="margin:2px 0 0 16px;font-size:0.78rem">${c.key_points.map(p => `<li>${escHtml(p)}</li>`).join('')}</ul>` : ''}
      </div>`).join('')}`;
}

function appendClassNoteCard(note, subject, container) {
  const card = document.createElement('div');
  card.className = 'class-note-card';
  card.dataset.id = note.id;

  const statusBadge = note.processing_status === 'done'
    ? `<span style="font-size:0.68rem;color:var(--pass-fg);margin-left:6px">✓ Analizado</span>`
    : note.processing_status === 'processing'
    ? `<span style="font-size:0.68rem;color:var(--text-muted);margin-left:6px">Procesando...</span>`
    : note.processing_status === 'error'
    ? `<span style="font-size:0.68rem;color:var(--fail-fg);margin-left:6px">Error</span>`
    : '';

  card.innerHTML = `
    <div class="class-note-header">
      <button type="button" class="class-note-toggle" aria-expanded="true">▾</button>
      <input type="text" class="class-note-title-input" value="${escHtml(note.title || '')}" placeholder="Título de la clase" maxlength="200">
      ${statusBadge}
      <button type="button" class="class-note-delete btn-ghost" style="font-size:0.72rem;padding:1px 7px">Eliminar</button>
    </div>
    <div class="class-note-body">
      <textarea class="class-note-content" placeholder="Contenido de la clase...">${escHtml(note.content || '')}</textarea>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <button type="button" class="class-note-process-btn btn-secondary" style="font-size:0.75rem;padding:2px 10px">Procesar transcript</button>
        ${note.has_structured ? `<button type="button" class="class-note-view-analysis-btn btn-ghost" style="font-size:0.75rem;padding:2px 10px">Ver análisis</button>` : ''}
      </div>
      <p class="class-note-transcript-feedback" style="font-size:0.78rem;margin:4px 0;color:var(--text-muted)"></p>
      <div class="class-note-structured-view" style="display:none;margin-top:8px"></div>
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

  // ── Transcript processing ──
  const transcriptFb = card.querySelector('.class-note-transcript-feedback');
  const structuredView = card.querySelector('.class-note-structured-view');

  const processBtn = card.querySelector('.class-note-process-btn');
  processBtn.addEventListener('click', async () => {
    const transcriptText = contentTextarea.value.trim();
    if (!transcriptText) {
      transcriptFb.textContent = 'Pegá el transcript en el contenido de la clase primero.';
      transcriptFb.style.color = 'var(--fail-fg)';
      return;
    }
    transcriptFb.textContent = 'Procesando... esto puede tardar 1-2 minutos.';
    transcriptFb.style.color = 'var(--text-muted)';
    processBtn.disabled = true;
    try {
      await postJson(`/curriculum/${encodeURIComponent(subject)}/class-notes/${note.id}/process-transcript`, { transcript_text: transcriptText });
      // Poll until done
      let nullPollCount = 0;
      const poll = setInterval(async () => {
        try {
          const data = await getJson(`/curriculum/${encodeURIComponent(subject)}/class-notes/${note.id}/structured`);
          if (data.processing_status === 'done') {
            clearInterval(poll);
            transcriptFb.textContent = 'Análisis completado.';
            transcriptFb.style.color = 'var(--pass-fg)';
            processBtn.disabled = false;
            structuredView.style.display = '';
            renderStructuredNote(data.structured_data, structuredView);
            // Show "Ver análisis" button if not already there
            if (!card.querySelector('.class-note-view-analysis-btn')) {
              const viewBtn = document.createElement('button');
              viewBtn.type = 'button';
              viewBtn.className = 'class-note-view-analysis-btn btn-ghost';
              viewBtn.style.cssText = 'font-size:0.75rem;padding:2px 10px';
              viewBtn.textContent = 'Ocultar análisis';
              processBtn.insertAdjacentElement('afterend', viewBtn);
              wireViewAnalysisBtn(viewBtn);
            }
          } else if (data.processing_status === 'error') {
            clearInterval(poll);
            transcriptFb.textContent = 'Error al procesar el transcript.';
            transcriptFb.style.color = 'var(--fail-fg)';
            processBtn.disabled = false;
          } else if (!data.processing_status) {
            // null can mean "not started yet" (race) — wait a few polls before giving up
            nullPollCount++;
            if (nullPollCount >= 3) {
              clearInterval(poll);
              transcriptFb.textContent = 'Error al procesar el transcript.';
              transcriptFb.style.color = 'var(--fail-fg)';
              processBtn.disabled = false;
            }
          }
        } catch (_e) { clearInterval(poll); processBtn.disabled = false; }
      }, 3000);
    } catch (_e) {
      transcriptFb.textContent = 'Error al iniciar el procesamiento.';
      transcriptFb.style.color = 'var(--fail-fg)';
      processBtn.disabled = false;
    }
  });

  function wireViewAnalysisBtn(btn) {
    btn.addEventListener('click', async () => {
      if (structuredView.style.display !== 'none') {
        structuredView.style.display = 'none';
        btn.textContent = 'Ver análisis';
        return;
      }
      structuredView.style.display = '';
      btn.textContent = 'Ocultar análisis';
      if (!structuredView.innerHTML) {
        try {
          const data = await getJson(`/curriculum/${encodeURIComponent(subject)}/class-notes/${note.id}/structured`);
          renderStructuredNote(data.structured_data, structuredView);
        } catch (_e) { structuredView.innerHTML = '<p style="color:var(--fail-fg);font-size:0.8rem">Error al cargar análisis.</p>'; }
      }
    });
  }

  const existingViewBtn = card.querySelector('.class-note-view-analysis-btn');
  if (existingViewBtn) wireViewAnalysisBtn(existingViewBtn);

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

// ── Bot chat panel ────────────────────────────────────────────────────────────

const BOT_LAST_READ_KEY = 'discriminador_bot_last_read';

function getBotLastRead() {
  return localStorage.getItem(BOT_LAST_READ_KEY) || new Date(0).toISOString();
}

function setBotLastRead() {
  localStorage.setItem(BOT_LAST_READ_KEY, new Date().toISOString());
}

function fmtChatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderMessages(messages) {
  const container = document.querySelector('#bot-chat-messages');
  if (!messages.length) {
    container.innerHTML = '<div class="bot-chat-empty">Sin mensajes aún. El asistente te escribirá cuando detecte que una materia necesita atención.</div>';
    return;
  }
  container.innerHTML = '';
  for (const msg of messages) {
    const bubble = document.createElement('div');
    bubble.className = `bot-chat-bubble bot-chat-bubble--${msg.direction === 'outbound' ? 'bot' : 'user'}`;
    bubble.innerHTML = `
      <div class="bot-chat-bubble-body">${msg.body.replace(/\n/g, '<br>')}</div>
      <div class="bot-chat-bubble-time">${fmtChatTime(msg.created_at)}</div>
    `;
    container.appendChild(bubble);
  }
  container.scrollTop = container.scrollHeight;
}

async function loadBotMessages() {
  try {
    const data = await getJson('/bot/messages?limit=50');
    renderMessages(data.messages || []);
  } catch { /* silent */ }
}

async function loadSnoozes() {
  try {
    const data = await getJson('/bot/snoozes');
    const list  = document.querySelector('#bot-chat-snoozes-list');
    const panel = document.querySelector('#bot-chat-snoozes');
    const snoozes = data.snoozes || [];
    if (!snoozes.length) {
      panel.classList.add('hidden');
      return;
    }
    list.innerHTML = '';
    for (const s of snoozes) {
      const row = document.createElement('div');
      row.className = 'bot-snooze-row';
      row.innerHTML = `
        <span class="bot-snooze-subject">${s.subject}</span>
        <span class="bot-snooze-until">hasta ${new Date(s.snoozed_until).toLocaleDateString('es-AR')}</span>
        <button class="btn-ghost bot-snooze-cancel" data-subject="${s.subject}" title="Cancelar silencio">✕</button>
      `;
      row.querySelector('.bot-snooze-cancel').addEventListener('click', async (e) => {
        const subj = e.target.dataset.subject;
        try {
          await fetch(`/bot/snoozes/${encodeURIComponent(subj)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${localStorage.getItem('discriminador_token')}` }
          });
          await loadSnoozes();
        } catch { /* silent */ }
      });
      list.appendChild(row);
    }
    panel.classList.remove('hidden');
  } catch { /* silent */ }
}

async function updateBotBadge() {
  try {
    const since = getBotLastRead();
    const data  = await getJson(`/bot/unread-count?since=${encodeURIComponent(since)}`);
    const badge = document.querySelector('#bot-chat-badge');
    const count = data.unread || 0;
    if (count > 0) {
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch { /* silent */ }
}

function initBotChat() {
  const fab          = document.querySelector('#bot-chat-fab');
  const panel        = document.querySelector('#bot-chat-panel');
  const closeBtn     = document.querySelector('#bot-chat-close');
  const sendBtn      = document.querySelector('#bot-chat-send');
  const statusBtn    = document.querySelector('#bot-chat-status-btn');
  const input        = document.querySelector('#bot-chat-input');
  const snoozesToggle = document.querySelector('#bot-chat-snoozes-btn');
  const snoozesPanel  = document.querySelector('#bot-chat-snoozes');

  if (!fab) return;

  // Open panel
  fab.addEventListener('click', async () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      setBotLastRead();
      document.querySelector('#bot-chat-badge').classList.add('hidden');
      await loadBotMessages();
      await loadSnoozes();
      input.focus();
    }
  });

  closeBtn.addEventListener('click', () => panel.classList.add('hidden'));

  // Toggle snoozes section
  snoozesToggle.addEventListener('click', () => {
    snoozesPanel.classList.toggle('hidden');
    if (!snoozesPanel.classList.contains('hidden')) loadSnoozes();
  });

  // Check system status on demand
  statusBtn.addEventListener('click', async () => {
    statusBtn.disabled = true;
    const container = document.querySelector('#bot-chat-messages');
    container.querySelector('.bot-chat-empty')?.remove();
    const thinking = document.createElement('div');
    thinking.className = 'bot-chat-bubble bot-chat-bubble--bot bot-chat-thinking';
    thinking.innerHTML = '<div class="bot-chat-bubble-body">...</div>';
    container.appendChild(thinking);
    container.scrollTop = container.scrollHeight;
    try {
      const data = await postJson('/bot/status', {});
      thinking.remove();
      const botBubble = document.createElement('div');
      botBubble.className = 'bot-chat-bubble bot-chat-bubble--bot';
      botBubble.innerHTML = `<div class="bot-chat-bubble-body">${(data.reply || '').replace(/\n/g, '<br>')}</div><div class="bot-chat-bubble-time">ahora</div>`;
      container.appendChild(botBubble);
      container.scrollTop = container.scrollHeight;
    } catch (err) {
      thinking.remove();
      const errBubble = document.createElement('div');
      errBubble.className = 'bot-chat-bubble bot-chat-bubble--bot';
      errBubble.innerHTML = `<div class="bot-chat-bubble-body" style="color:var(--fail-fg)">Error: ${err.message}</div>`;
      container.appendChild(errBubble);
    } finally {
      statusBtn.disabled = false;
    }
  });

  // Send message
  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    sendBtn.disabled = true;

    // Optimistically add user bubble
    const container = document.querySelector('#bot-chat-messages');
    const userBubble = document.createElement('div');
    userBubble.className = 'bot-chat-bubble bot-chat-bubble--user';
    userBubble.innerHTML = `<div class="bot-chat-bubble-body">${text.replace(/\n/g, '<br>')}</div><div class="bot-chat-bubble-time">ahora</div>`;
    container.querySelector('.bot-chat-empty')?.remove();
    container.appendChild(userBubble);
    container.scrollTop = container.scrollHeight;

    // Thinking indicator
    const thinking = document.createElement('div');
    thinking.className = 'bot-chat-bubble bot-chat-bubble--bot bot-chat-thinking';
    thinking.innerHTML = '<div class="bot-chat-bubble-body">...</div>';
    container.appendChild(thinking);
    container.scrollTop = container.scrollHeight;

    try {
      const data = await postJson('/bot/reply', { text });
      thinking.remove();
      const botBubble = document.createElement('div');
      botBubble.className = 'bot-chat-bubble bot-chat-bubble--bot';
      botBubble.innerHTML = `<div class="bot-chat-bubble-body">${(data.reply || '').replace(/\n/g, '<br>')}</div><div class="bot-chat-bubble-time">ahora</div>`;
      container.appendChild(botBubble);
      container.scrollTop = container.scrollHeight;
      await loadSnoozes();
    } catch (err) {
      thinking.remove();
      const errBubble = document.createElement('div');
      errBubble.className = 'bot-chat-bubble bot-chat-bubble--bot';
      errBubble.innerHTML = `<div class="bot-chat-bubble-body" style="color:var(--fail-fg)">Error: ${err.message}</div>`;
      container.appendChild(errBubble);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Poll for unread badge every 60s
  updateBotBadge();
  setInterval(updateBotBadge, 60_000);
}

initBotChat();

// ─── Settings tab ─────────────────────────────────────────────────────────────

function initSettingsTab() {
  const planningEl         = document.querySelector('#setting-session-planning');
  const gratitudeEl        = document.querySelector('#setting-gratitude');
  const timeRestrictEl     = document.querySelector('#setting-time-restriction');
  const plannerGateEl      = document.querySelector('#setting-planner-gate');
  const realtimeBreakEl    = document.querySelector('#setting-realtime-break-notifications');
  const ttsEl              = document.querySelector('#setting-tts-enabled');
  const defTimeEl          = document.querySelector('#setting-default-time');
  const defEnergyEl        = document.querySelector('#setting-default-energy');
  const dailyTargetEl      = document.querySelector('#setting-daily-target');
  const dailyBudgetEl      = document.querySelector('#setting-daily-budget');
  const defRetentionEl     = document.querySelector('#setting-default-retention');
  const defStrictnessEl    = document.querySelector('#setting-default-strictness');
  const statusEl           = document.querySelector('#settings-save-status');

  // Populate from current state
  planningEl.checked      = userSettings.session_planning_enabled;
  gratitudeEl.checked     = userSettings.gratitude_enabled;
  timeRestrictEl.checked  = userSettings.time_restriction_enabled;
  plannerGateEl.checked   = userSettings.planner_gate_enabled;
  realtimeBreakEl.checked = userSettings.realtime_break_notifications_enabled;
  ttsEl.checked           = getTTSEnabled();
  defTimeEl.value         = getDefaultBriefingTime();
  defEnergyEl.value       = getDefaultBriefingEnergy();
  dailyTargetEl.value     = getDailyTarget();
  dailyBudgetEl.value     = getDailyBudget();
  if (userSettings.default_retention_floor    != null) defRetentionEl.value  = userSettings.default_retention_floor;
  if (userSettings.default_grading_strictness != null) defStrictnessEl.value = userSettings.default_grading_strictness;

  let saveTimer = null;

  function flash() {
    statusEl.textContent = 'Guardado.';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }

  async function saveServerSettings() {
    const payload = {
      session_planning_enabled:   planningEl.checked,
      gratitude_enabled:          gratitudeEl.checked,
      time_restriction_enabled:   timeRestrictEl.checked,
      planner_gate_enabled:       plannerGateEl.checked,
      realtime_break_notifications_enabled: realtimeBreakEl.checked,
      default_retention_floor:    defRetentionEl.value    !== '' ? parseInt(defRetentionEl.value)    : null,
      default_grading_strictness: defStrictnessEl.value   !== '' ? parseInt(defStrictnessEl.value)   : null,
    };
    try {
      const saved = await postJson('/settings', payload, 'PUT');
      Object.assign(userSettings, saved);
      flash();
    } catch (err) {
      statusEl.textContent = `Error al guardar: ${err.message}`;
    }
  }

  function scheduleServerSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveServerSettings, 400);
  }

  // Server-persisted toggles
  planningEl.addEventListener('change',     scheduleServerSave);
  gratitudeEl.addEventListener('change',    scheduleServerSave);
  timeRestrictEl.addEventListener('change', scheduleServerSave);
  plannerGateEl.addEventListener('change',  scheduleServerSave);
  realtimeBreakEl.addEventListener('change', scheduleServerSave);
  defRetentionEl.addEventListener('change', scheduleServerSave);
  defStrictnessEl.addEventListener('change', scheduleServerSave);

  // localStorage — immediate
  ttsEl.addEventListener('change', () => { setTTSEnabled(ttsEl.checked); flash(); });
  defTimeEl.addEventListener('change',   () => { setDefaultBriefingTime(defTimeEl.value);     flash(); });
  defEnergyEl.addEventListener('change', () => { setDefaultBriefingEnergy(defEnergyEl.value); flash(); });

  dailyTargetEl.addEventListener('change', () => {
    const n = parseInt(dailyTargetEl.value);
    if (Number.isFinite(n) && n > 0) { setDailyTarget(n); flash(); }
    else dailyTargetEl.value = getDailyTarget();
  });

  dailyBudgetEl.addEventListener('change', () => {
    const n = parseInt(dailyBudgetEl.value);
    if (Number.isFinite(n) && n >= 10) { setDailyBudget(n); flash(); }
    else dailyBudgetEl.value = getDailyBudget();
  });
}

// ─── Documentos tab ────────────────────────────────────────────────────────────

function formatDocDate(isoStr) {
  const d = new Date(isoStr);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1)  return 'ahora';
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24)   return `hace ${diffH} h`;
  const diffD = Math.round(diffH / 24);
  if (diffD === 1)  return 'ayer';
  if (diffD < 30)   return `hace ${diffD} días`;
  return d.toLocaleDateString('es-AR');
}

function initDocumentsTab() {
  const createBtn     = document.getElementById('doc-create-btn');
  const nameInput     = document.getElementById('doc-name-input');
  const textInput     = document.getElementById('doc-text-input');
  const subjectInput  = document.getElementById('doc-subject-input');
  const feedback      = document.getElementById('doc-create-feedback');
  const listEl        = document.getElementById('docs-list');
  const loadingEl     = document.getElementById('docs-loading');
  const emptyEl       = document.getElementById('docs-empty');

  // documentId → setInterval id for background polling
  const polling = new Map();

  // ── Load list ────────────────────────────────────────────────────────────────
  async function loadDocuments() {
    loadingEl.classList.remove('hidden');
    listEl.innerHTML = '';
    emptyEl.classList.add('hidden');

    try {
      const data = await getJson('/api/documents');
      loadingEl.classList.add('hidden');

      if (!data || !data.documents || data.documents.length === 0) {
        emptyEl.classList.remove('hidden');
        return;
      }

      const NO_SUBJECT = '\x00';
      const groups = new Map();
      for (const doc of data.documents) {
        const key = doc.subject || NO_SUBJECT;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(doc);
      }

      const sortedKeys = [...groups.keys()].sort((a, b) => {
        if (a === NO_SUBJECT) return 1;
        if (b === NO_SUBJECT) return -1;
        return a.localeCompare(b, 'es');
      });

      for (const key of sortedKeys) {
        const subject = key === NO_SUBJECT ? null : key;
        listEl.appendChild(renderSubjectGroup(subject, groups.get(key)));
      }
    } catch (err) {
      loadingEl.classList.add('hidden');
      loadingEl.textContent = `Error al cargar: ${err.message}`;
    }
  }

  // ── Render a group of documents under a subject heading ───────────────────────
  function renderSubjectGroup(subject, docs) {
    const group = document.createElement('div');
    group.className = 'docs-subject-group';
    group.dataset.subject = subject || '';

    const label = subject || 'Sin materia';
    const count = docs.length;

    group.innerHTML = `
      <div class="docs-subject-group-header">
        <span class="docs-subject-group-arrow">▶</span>
        <span class="docs-subject-group-name">${escHtml(label)}</span>
        <span class="docs-subject-group-count">${count} documento${count !== 1 ? 's' : ''}</span>
      </div>
      <div class="docs-subject-group-body"></div>
    `;

    const header = group.querySelector('.docs-subject-group-header');
    const body   = group.querySelector('.docs-subject-group-body');

    docs.forEach(doc => body.appendChild(renderDocItem(doc)));

    header.addEventListener('click', () => group.classList.toggle('open'));

    return group;
  }

  // ── Render a single document row ─────────────────────────────────────────────
  function renderDocItem(doc) {
    const item = document.createElement('div');
    item.className = 'docs-document-item';
    item.dataset.docId = doc.id;

    const name      = doc.original_filename || 'Sin nombre';
    const words     = doc.word_count != null ? `${Number(doc.word_count).toLocaleString('es-AR')} palabras` : '';
    const date      = formatDocDate(doc.created_at);
    const metaParts = [words, date].filter(Boolean);

    item.dataset.subject = doc.subject || '';

    item.innerHTML = `
      <div class="docs-document-header">
        <span class="docs-document-name" title="${escHtml(name)}">${escHtml(name)}</span>
        <span class="docs-document-meta">${escHtml(metaParts.join(' · '))}</span>
      </div>
      <div class="docs-subject-row">
        <span class="docs-subject-display ${doc.subject ? '' : 'docs-subject-empty'}">
          ${doc.subject ? `<span class="docs-subject-label">Materia:</span> ${escHtml(doc.subject)}` : 'Sin materia asignada'}
        </span>
        <button type="button" class="btn-ghost docs-subject-edit-btn" title="Editar materia" style="font-size:var(--fs-sm);padding:2px 6px">✎</button>
        <span class="docs-subject-form hidden">
          <input type="text" class="docs-subject-input" list="subjects-list" placeholder="Ej: Derecho Civil" autocomplete="off" style="font-size:var(--fs-sm);padding:3px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--input-bg);font-family:var(--font);width:200px">
          <button type="button" class="btn-primary docs-subject-save-btn" style="font-size:var(--fs-sm);padding:3px 10px">Guardar</button>
          <button type="button" class="btn-ghost docs-subject-cancel-btn" style="font-size:var(--fs-sm);padding:3px 8px">✕</button>
        </span>
      </div>
      <div class="docs-no-subject-warning ${doc.subject ? 'hidden' : ''}">
        ⚠ Sin materia asignada — el exam_score quedará null al rankear. Asigná una materia para activar la brújula de exámenes.
      </div>
      <div class="docs-document-actions">
        <button type="button" class="btn-secondary docs-extract-btn">Extraer conceptos</button>
        <button type="button" class="docs-concepts-toggle hidden">
          <span class="docs-toggle-count">0 conceptos</span>
          <span class="docs-toggle-arrow">▼</span>
        </button>
        <button type="button" class="btn-secondary docs-clusterize-btn" disabled title="Extraé conceptos primero">Clusterizar</button>
        <button type="button" class="docs-clusters-toggle hidden">
          <span class="docs-clusters-count">0 clusters</span>
          <span class="docs-toggle-arrow">▼</span>
        </button>
        <button type="button" class="btn-secondary docs-rank-btn hidden" title="Calcular importancia de clusters">Rankear clusters</button>
        <button type="button" class="docs-ranking-toggle hidden">
          <span class="docs-ranking-label">ver ranking</span>
          <span class="docs-toggle-arrow">▼</span>
        </button>
        <button type="button" class="btn-ghost docs-view-content-btn" style="font-size:var(--fs-sm)" title="Ver texto del documento">Ver contenido</button>
        <button type="button" class="btn-ghost docs-load-exam-btn ${doc.subject ? '' : 'hidden'}" style="font-size:var(--fs-sm)" title="Cargar examen de referencia para esta materia">+ Examen de referencia</button>
        <button type="button" class="btn-ghost docs-delete-btn" style="font-size:var(--fs-sm)">Eliminar</button>
        <span class="docs-extract-status"></span>
      </div>
      <div class="docs-concepts-panel"></div>
      <div class="docs-clusters-panel"></div>
      <div class="docs-ranking-panel"></div>
      <div class="docs-content-panel hidden"></div>
      <div class="docs-exam-load-panel hidden"></div>
    `;

    if (doc.concept_count > 0) updateConceptBadge(item, doc.concept_count);
    if (doc.cluster_count > 0) updateClusterBadge(item, doc.cluster_count);
    if (doc.has_ranking)       showRankingToggle(item);

    wire(item, doc.id, doc.subject);
    return item;
  }

  // ── Wire button events ────────────────────────────────────────────────────────
  function wire(item, docId, initialSubject) {
    item.querySelector('.docs-extract-btn').addEventListener('click', () => extractConcepts(docId, item));
    item.querySelector('.docs-concepts-toggle').addEventListener('click', () => togglePanel(docId, item));
    item.querySelector('.docs-clusterize-btn').addEventListener('click', () => clusterizeConcepts(docId, item));
    item.querySelector('.docs-clusters-toggle').addEventListener('click', () => toggleClustersPanel(docId, item));
    item.querySelector('.docs-rank-btn').addEventListener('click', () => rankClusters(docId, item));
    item.querySelector('.docs-ranking-toggle').addEventListener('click', () => toggleRankingPanel(docId, item));
    item.querySelector('.docs-delete-btn').addEventListener('click', () => deleteDoc(docId, item));
    item.querySelector('.docs-view-content-btn').addEventListener('click', () => toggleContentPanel(docId, item));
    item.querySelector('.docs-load-exam-btn').addEventListener('click', () => toggleExamLoadPanel(item));
    wireSubjectEdit(item, docId, initialSubject);
  }

  // ── Subject inline edit ───────────────────────────────────────────────────────
  function wireSubjectEdit(item, docId, initialSubject) {
    const editBtn    = item.querySelector('.docs-subject-edit-btn');
    const display    = item.querySelector('.docs-subject-display');
    const form       = item.querySelector('.docs-subject-form');
    const input      = item.querySelector('.docs-subject-input');
    const saveBtn    = item.querySelector('.docs-subject-save-btn');
    const cancelBtn  = item.querySelector('.docs-subject-cancel-btn');

    if (initialSubject) input.value = initialSubject;

    editBtn.addEventListener('click', () => {
      display.classList.add('hidden');
      editBtn.classList.add('hidden');
      form.classList.remove('hidden');
      input.focus();
    });

    cancelBtn.addEventListener('click', () => {
      form.classList.add('hidden');
      display.classList.remove('hidden');
      editBtn.classList.remove('hidden');
    });

    saveBtn.addEventListener('click', () => saveSubject(docId, item, input.value.trim()));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveSubject(docId, item, input.value.trim());
      if (e.key === 'Escape') cancelBtn.click();
    });
  }

  async function saveSubject(docId, item, subject) {
    const display   = item.querySelector('.docs-subject-display');
    const form      = item.querySelector('.docs-subject-form');
    const editBtn   = item.querySelector('.docs-subject-edit-btn');
    const saveBtn   = item.querySelector('.docs-subject-save-btn');

    saveBtn.disabled = true;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (Auth.getToken()) headers['Authorization'] = 'Bearer ' + Auth.getToken();
      const res = await fetch(`/api/documents/${docId}/subject`, {
        method: 'PATCH', headers, body: JSON.stringify({ subject: subject || null }),
      });
      Auth.handleRefreshToken(res);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const saved = data.subject || null;

      display.className = `docs-subject-display ${saved ? '' : 'docs-subject-empty'}`;
      display.innerHTML = saved
        ? `<span class="docs-subject-label">Materia:</span> ${escHtml(saved)}`
        : 'Sin materia asignada';

      // Update compass warning and exam loader button visibility
      item.dataset.subject = saved || '';
      const warning = item.querySelector('.docs-no-subject-warning');
      if (warning) warning.classList.toggle('hidden', Boolean(saved));
      const loadExamBtn = item.querySelector('.docs-load-exam-btn');
      if (loadExamBtn) loadExamBtn.classList.toggle('hidden', !saved);

      await loadDocuments();
    } catch (err) {
      showToast(`Error al guardar materia: ${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ── Update the concepts count badge ──────────────────────────────────────────
  function updateConceptBadge(item, count) {
    const toggle        = item.querySelector('.docs-concepts-toggle');
    const label         = item.querySelector('.docs-toggle-count');
    const clusterizeBtn = item.querySelector('.docs-clusterize-btn');
    if (count > 0) {
      label.textContent = `${count} concepto${count !== 1 ? 's' : ''}`;
      toggle.classList.remove('hidden');
      // Enable "Clusterizar" only when no clusters exist yet
      if (item.querySelector('.docs-clusters-toggle').classList.contains('hidden')) {
        clusterizeBtn.disabled = false;
        clusterizeBtn.title    = '';
      }
    } else {
      toggle.classList.add('hidden');
      clusterizeBtn.disabled = true;
      clusterizeBtn.title    = 'Extraé conceptos primero';
    }
  }

  // ── Update the cluster count badge ───────────────────────────────────────────
  function showRankingToggle(item) {
    item.querySelector('.docs-ranking-toggle').classList.remove('hidden');
  }

  function updateClusterBadge(item, count) {
    const toggle        = item.querySelector('.docs-clusters-toggle');
    const label         = item.querySelector('.docs-clusters-count');
    const clusterizeBtn = item.querySelector('.docs-clusterize-btn');
    const rankBtn       = item.querySelector('.docs-rank-btn');
    if (count > 0) {
      label.textContent = `${count} cluster${count !== 1 ? 's' : ''}`;
      toggle.classList.remove('hidden');
      clusterizeBtn.classList.add('hidden');  // replaced by toggle
      rankBtn.classList.remove('hidden');
    } else {
      toggle.classList.add('hidden');
      rankBtn.classList.add('hidden');
    }
  }

  // ── Toggle inline concepts panel ─────────────────────────────────────────────
  async function togglePanel(docId, item) {
    const panel  = item.querySelector('.docs-concepts-panel');
    const toggle = item.querySelector('.docs-concepts-toggle');
    const isOpen = panel.classList.contains('open');

    panel.classList.toggle('open', !isOpen);
    toggle.classList.toggle('open', !isOpen);

    if (isOpen) return; // closing — no fetch needed

    panel.innerHTML = '<span style="color:var(--text-muted);font-size:var(--fs-sm)">Cargando...</span>';

    try {
      const data = await getJson(`/api/documents/${docId}/concepts`);
      renderConceptsInPanel(panel, data);
      updateConceptBadge(item, data.concept_count);
    } catch (err) {
      panel.innerHTML = `<span style="color:var(--fail-fg);font-size:var(--fs-sm)">Error: ${escHtml(err.message)}</span>`;
    }
  }

  function renderConceptsInPanel(panel, data) {
    if (!data.concepts || data.concepts.length === 0) {
      panel.innerHTML = '<p style="color:var(--text-muted);font-size:var(--fs-sm);margin:0">Sin conceptos extraídos aún.</p>';
      return;
    }
    panel.innerHTML = data.concepts.map(c => `
      <div class="docs-concept-item">
        <div class="docs-concept-label">
          ${escHtml(c.label)}
          ${c.source_chunk_index != null
            ? `<span class="docs-concept-chunk">fragmento ${c.source_chunk_index + 1}</span>`
            : ''}
        </div>
        <div class="docs-concept-definition">${escHtml(c.definition)}</div>
        ${c.evidence ? `<div class="docs-concept-evidence">"${escHtml(c.evidence)}"</div>` : ''}
      </div>
    `).join('');
  }

  // ── Cluster concepts ──────────────────────────────────────────────────────────
  async function clusterizeConcepts(docId, item) {
    const btn      = item.querySelector('.docs-clusterize-btn');
    const statusEl = item.querySelector('.docs-extract-status');

    btn.disabled    = true;
    btn.textContent = 'Clusterizando...';
    statusEl.textContent = '';
    statusEl.style.color = '';

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (Auth.getToken()) headers['Authorization'] = 'Bearer ' + Auth.getToken();

      const res = await fetch(`/api/documents/${docId}/cluster-concepts`, { method: 'POST', headers });
      Auth.handleRefreshToken(res);

      const payload = await res.json().catch(() => ({}));

      if (res.status === 409) {
        // Already clustered — fetch existing clusters and show them
        statusEl.textContent = 'Ya clusterizado.';
        const existing = await getJson(`/api/documents/${docId}/clusters`).catch(() => null);
        if (existing && existing.cluster_count > 0) {
          updateClusterBadge(item, existing.cluster_count);
          const panel = item.querySelector('.docs-clusters-panel');
          renderClustersInPanel(panel, existing);
          panel.classList.add('open');
          item.querySelector('.docs-clusters-toggle').classList.add('open');
        }
        return;
      }

      if (!res.ok) throw new Error(payload.message || `HTTP ${res.status}`);

      statusEl.textContent = `${payload.cluster_count} cluster${payload.cluster_count !== 1 ? 's' : ''} creados.`;
      updateClusterBadge(item, payload.cluster_count);

      const panel = item.querySelector('.docs-clusters-panel');
      renderClustersInPanel(panel, payload);
      panel.classList.add('open');
      item.querySelector('.docs-clusters-toggle').classList.add('open');
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.style.color = 'var(--fail-fg)';
      btn.disabled    = false;
      btn.textContent = 'Clusterizar';
    }
  }

  // ── Toggle inline clusters panel ─────────────────────────────────────────────
  async function toggleClustersPanel(docId, item) {
    const panel  = item.querySelector('.docs-clusters-panel');
    const toggle = item.querySelector('.docs-clusters-toggle');
    const isOpen = panel.classList.contains('open');

    panel.classList.toggle('open', !isOpen);
    toggle.classList.toggle('open', !isOpen);

    if (isOpen) return;

    panel.innerHTML = '<span style="color:var(--text-muted);font-size:var(--fs-sm)">Cargando...</span>';

    try {
      const data = await getJson(`/api/documents/${docId}/clusters`);
      renderClustersInPanel(panel, data);
      updateClusterBadge(item, data.cluster_count);
    } catch (err) {
      panel.innerHTML = `<span style="color:var(--fail-fg);font-size:var(--fs-sm)">Error: ${escHtml(err.message)}</span>`;
    }
  }

  function renderClustersInPanel(panel, data) {
    if (!data.clusters || data.clusters.length === 0) {
      panel.innerHTML = '<p style="color:var(--text-muted);font-size:var(--fs-sm);margin:0">Sin clusters aún.</p>';
      return;
    }
    panel.innerHTML = data.clusters.map(cl => `
      <div class="docs-cluster-item">
        <div class="docs-cluster-name">${escHtml(cl.name)}</div>
        <div class="docs-cluster-definition">${escHtml(cl.definition)}</div>
        <div class="docs-cluster-concepts">
          ${cl.concepts.map(c => `<span class="docs-cluster-concept-tag">${escHtml(c.label)}</span>`).join('')}
        </div>
      </div>
    `).join('');
  }

  // ── Extract concepts ──────────────────────────────────────────────────────────
  async function extractConcepts(docId, item) {
    const btn      = item.querySelector('.docs-extract-btn');
    const statusEl = item.querySelector('.docs-extract-status');

    btn.disabled    = true;
    btn.textContent = 'Extrayendo...';
    statusEl.textContent = '';
    statusEl.style.color = '';

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (Auth.getToken()) headers['Authorization'] = 'Bearer ' + Auth.getToken();

      const res = await fetch(`/api/documents/${docId}/extract-concepts`, { method: 'POST', headers });
      Auth.handleRefreshToken(res);

      if (res.status === 202) {
        statusEl.textContent = 'Procesando en segundo plano...';
        btn.textContent = 'Extraer conceptos';
        btn.disabled    = false;
        startPolling(docId, item);
        return;
      }

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `HTTP ${res.status}`);

      statusEl.textContent = `${payload.concept_count} concepto${payload.concept_count !== 1 ? 's' : ''} extraídos.`;
      updateConceptBadge(item, payload.concept_count);

      const panel = item.querySelector('.docs-concepts-panel');
      if (panel.classList.contains('open')) renderConceptsInPanel(panel, payload);
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.style.color = 'var(--fail-fg)';
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Extraer conceptos';
    }
  }

  // ── Background polling after async extraction ─────────────────────────────────
  function startPolling(docId, item) {
    if (polling.has(docId)) clearInterval(polling.get(docId));

    const statusEl = item.querySelector('.docs-extract-status');
    let attempts = 0;

    const id = setInterval(async () => {
      attempts++;
      if (attempts > 200) { // 10 min max
        clearInterval(id);
        polling.delete(docId);
        statusEl.textContent = 'La extracción tardó demasiado. Intentá de nuevo.';
        return;
      }
      try {
        const data = await getJson(`/api/documents/${docId}/concepts`);
        if (data.concept_count > 0) {
          clearInterval(id);
          polling.delete(docId);
          statusEl.textContent = `${data.concept_count} concepto${data.concept_count !== 1 ? 's' : ''} extraídos.`;
          updateConceptBadge(item, data.concept_count);

          const panel = item.querySelector('.docs-concepts-panel');
          if (panel.classList.contains('open')) renderConceptsInPanel(panel, data);
        }
      } catch { /* ignore transient polling errors */ }
    }, 3000);

    polling.set(docId, id);
  }

  // ── Delete document ───────────────────────────────────────────────────────────
  async function deleteDoc(docId, item) {
    if (!confirm('¿Eliminar este documento y todos sus conceptos?')) return;

    try {
      const headers = {};
      if (Auth.getToken()) headers['Authorization'] = 'Bearer ' + Auth.getToken();
      const res = await fetch(`/api/documents/${docId}`, { method: 'DELETE', headers });
      Auth.handleRefreshToken(res);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || `HTTP ${res.status}`);
      }

      if (polling.has(docId)) { clearInterval(polling.get(docId)); polling.delete(docId); }
      item.remove();
      if (!listEl.querySelector('.docs-document-item')) emptyEl.classList.remove('hidden');
    } catch (err) {
      showToast(`Error al eliminar: ${err.message}`, 'error');
    }
  }

  // ── Rank clusters ─────────────────────────────────────────────────────────────
  async function rankClusters(docId, item) {
    const btn      = item.querySelector('.docs-rank-btn');
    const statusEl = item.querySelector('.docs-extract-status');

    btn.disabled    = true;
    btn.textContent = 'Rankeando...';
    statusEl.textContent = '';
    statusEl.style.color = '';

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (Auth.getToken()) headers['Authorization'] = 'Bearer ' + Auth.getToken();
      const res = await fetch(`/api/documents/${docId}/rank-clusters`, { method: 'POST', headers });
      Auth.handleRefreshToken(res);

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `HTTP ${res.status}`);

      statusEl.textContent = `Ranking calculado (${payload.cluster_count} clusters).`;

      const panel = item.querySelector('.docs-ranking-panel');
      renderRankingInPanel(panel, payload);
      panel.classList.add('open');

      const toggle = item.querySelector('.docs-ranking-toggle');
      toggle.classList.remove('hidden');
      toggle.classList.add('open');

      btn.textContent = 'Re-rankear';
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.style.color = 'var(--fail-fg)';
      btn.textContent = 'Rankear clusters';
    } finally {
      btn.disabled = false;
    }
  }

  async function toggleRankingPanel(docId, item) {
    const panel  = item.querySelector('.docs-ranking-panel');
    const toggle = item.querySelector('.docs-ranking-toggle');
    const isOpen = panel.classList.contains('open');

    panel.classList.toggle('open', !isOpen);
    toggle.classList.toggle('open', !isOpen);

    // Lazy-load stored ranking on first open (panel has no content yet)
    if (!isOpen && panel.children.length === 0) {
      panel.innerHTML = '<span style="color:var(--text-muted);font-size:var(--fs-sm)">Cargando ranking...</span>';
      try {
        const data = await getJson(`/api/documents/${docId}/rank-clusters`);
        renderRankingInPanel(panel, data);
      } catch (err) {
        panel.innerHTML = `<span style="color:var(--fail-fg);font-size:var(--fs-sm)">Error al cargar ranking: ${escHtml(err.message)}</span>`;
      }
    }
  }

  function renderRankingInPanel(panel, data) {
    if (!data.clusters || data.clusters.length === 0) {
      panel.innerHTML = '<p style="color:var(--text-muted);font-size:var(--fs-sm);margin:0">Sin ranking disponible.</p>';
      return;
    }

    const tierClass = { A: 'tier-a', B: 'tier-b', C: 'tier-c', D: 'tier-d' };

    panel.innerHTML = data.clusters.map(cl => {
      // Use relative tier as primary badge; fall back to absolute if not present
      const tier      = cl.relative_priority_tier || cl.priority_tier || '?';
      const relScore  = cl.relative_importance_score;
      const absScore  = cl.importance_score;
      const wasAdded  = Boolean(cl.cards_added_at);

      // Progress bar driven by relative score when available, else absolute
      const barPct    = relScore != null ? Math.round(relScore * 100) : (absScore != null ? Math.round(absScore * 100) : 0);
      const absLabel  = absScore != null ? (absScore * 100).toFixed(0) + '%' : '—';

      const densityPct = cl.density_score != null ? Math.round(cl.density_score * 100) : null;

      // Program signal — only show when not weak
      let programLabel = null;
      if (cl.program_score != null) {
        const pct = Math.round(cl.program_score * 100);
        const strength = cl.program_match_strength;
        if (strength === 'strong' || strength === 'moderate') {
          programLabel = `programa ${pct}%`;
        } else {
          programLabel = `programa débil ${pct}%`;
        }
      }

      // Exam signal with state label
      let examLabel = null;
      let examStateBadge = '';
      if (cl.exam_score != null) {
        const pct = Math.round(cl.exam_score * 100);
        const strength = cl.exam_match_strength;
        if (strength === 'strong') {
          examLabel = `examen ${pct}%`;
          examStateBadge = `<span class="docs-exam-state exam-state--strong">señal fuerte</span>`;
        } else if (strength === 'moderate') {
          examLabel = `examen ${pct}%`;
          examStateBadge = `<span class="docs-exam-state exam-state--moderate">señal moderada</span>`;
        } else {
          examLabel = `examen débil ${pct}%`;
          examStateBadge = `<span class="docs-exam-state exam-state--weak">señal débil</span>`;
        }
      } else {
        examLabel = 'sin examen';
        examStateBadge = `<span class="docs-exam-state exam-state--none">sin datos de examen</span>`;
      }

      const scoreDetails = [
        `density ${densityPct != null ? densityPct + '%' : '—'}`,
        programLabel,
        examLabel,
      ].filter(Boolean).join(' · ');

      const reasons = (cl.importance_reasons || [])
        .map(r => `<li>${escHtml(r)}</li>`)
        .join('');

      const relLabel = relScore != null ? `Top relativo · ${absLabel} absoluto` : absLabel;

      let cardsAddedLog = '';
      if (wasAdded) {
        const addedDate = new Date(cl.cards_added_at);
        const dateStr   = addedDate.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const countStr  = cl.cards_added_count != null
          ? `${cl.cards_added_count} tarjeta${cl.cards_added_count !== 1 ? 's' : ''}`
          : 'tarjetas';
        const subjectStr = cl.cards_added_subject
          ? ` &rarr; <em>${escHtml(cl.cards_added_subject)}</em>`
          : '';
        cardsAddedLog = `<div class="docs-cluster-added-log">&#10003; Tarjetas agregadas el ${escHtml(dateStr)} &middot; ${countStr}${subjectStr}</div>`;
      }

      return `
        <div class="docs-ranking-item${wasAdded ? ' docs-ranking-item--cards-added' : ''}" data-cluster-id="${escHtml(cl.id)}">
          <div class="docs-ranking-item-head">
            <span class="docs-tier-badge ${tierClass[tier] || ''}">${escHtml(tier)}</span>
            <div class="docs-ranking-score-bar-wrap">
              <div class="docs-ranking-score-bar" style="width:${barPct}%"></div>
            </div>
            <span class="docs-ranking-score-num">${escHtml(relLabel)}</span>
            <span class="docs-ranking-name">${escHtml(cl.name)}</span>
            ${examStateBadge}
            ${wasAdded ? '<span class="docs-cluster-added-badge">&#10003; Agregado</span>' : ''}
          </div>
          ${cl.definition ? `<div class="docs-ranking-def">${escHtml(cl.definition)}</div>` : ''}
          <div class="docs-ranking-signals">${escHtml(scoreDetails)}</div>
          ${reasons ? `<ul class="docs-ranking-reasons">${reasons}</ul>` : ''}
          ${cardsAddedLog}
          <div class="docs-ranking-item-actions">
            <button type="button" class="btn-secondary docs-generate-card-btn" data-cluster-id="${escHtml(cl.id)}">Generar cards</button>
            <span class="docs-generate-card-status"></span>
          </div>
          <div class="docs-card-draft-panel hidden"></div>
        </div>
      `;
    }).join('');

    // Show no-exam banner if all clusters have exam_score null
    const allNullExam = data.clusters.every(cl => cl.exam_score == null);
    if (allNullExam && data.clusters.length > 0) {
      panel.insertAdjacentHTML('afterbegin',
        `<div class="docs-no-exam-banner">
          Sin exámenes de referencia para esta materia. El ranking se basa solo en densidad.
         </div>`
      );
    }

    // Wire generate-card buttons
    panel.querySelectorAll('.docs-generate-card-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const rankingItem = btn.closest('.docs-ranking-item');
        generateCardDraftUI(btn.dataset.clusterId, rankingItem);
      });
    });
  }

  // ── Generate card draft from cluster ─────────────────────────────────────────
  async function generateCardDraftUI(clusterId, rankingItem) {
    const btn      = rankingItem.querySelector('.docs-generate-card-btn');
    const statusEl = rankingItem.querySelector('.docs-generate-card-status');
    const draftPanel = rankingItem.querySelector('.docs-card-draft-panel');

    btn.disabled    = true;
    btn.textContent = 'Generando...';
    statusEl.textContent = '';
    statusEl.className = 'docs-generate-card-status';

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (Auth.getToken()) headers['Authorization'] = 'Bearer ' + Auth.getToken();

      const res = await fetch(`/api/clusters/${clusterId}/generate-card-draft`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      Auth.handleRefreshToken(res);

      if (res.status === 409) {
        // Draft already exists — fetch and show it
        statusEl.textContent = 'Ya existe un draft. Cargando...';
        btn.textContent = 'Ver draft';
        btn.disabled = false;
        btn.classList.add('docs-generate-card-btn--has-draft');

        const existing = await fetch(`/api/clusters/${clusterId}/card-draft`, { headers: { 'Authorization': headers['Authorization'] } });
        Auth.handleRefreshToken(existing);
        if (existing.ok) {
          const data = await existing.json();
          renderCardDraftPanel(draftPanel, data);
          statusEl.textContent = '';
          btn.addEventListener('click', () => draftPanel.classList.toggle('hidden'), { once: false });
        } else {
          statusEl.textContent = 'Draft existente (no se pudo cargar).';
          statusEl.className = 'docs-generate-card-status docs-generate-card-status--warn';
        }
        return;
      }

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `HTTP ${res.status}`);

      renderCardDraftPanel(draftPanel, payload);
      btn.textContent = 'Ver draft';
      btn.classList.add('docs-generate-card-btn--has-draft');
      btn.disabled = false;
      btn.addEventListener('click', () => draftPanel.classList.toggle('hidden'), { once: false });
      statusEl.textContent = `${payload.variants.length} variante${payload.variants.length !== 1 ? 's' : ''} generada${payload.variants.length !== 1 ? 's' : ''}.`;
      statusEl.className = 'docs-generate-card-status docs-generate-card-status--ok';
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'docs-generate-card-status docs-generate-card-status--error';
      btn.disabled = false;
      btn.textContent = 'Reintentar';
    }
  }

  // ── Render card draft panel ───────────────────────────────────────────────────
  function renderCardDraftPanel(panel, data) {
    const difficultyLabel = { easy: 'Fácil', medium: 'Media', hard: 'Difícil' };
    const difficultyClass = { easy: 'diff-easy', medium: 'diff-medium', hard: 'diff-hard' };
    const cardId = data.card_group?.id;
    const subjectDefault = data.document?.subject_name || data.card_group?.subject || '';

    const variantsHTML = (data.variants || []).map((v, i) => {
      const rubricItems = (v.grading_rubric || []).map(r => `<li>${escHtml(r)}</li>`).join('');
      const diff = v.difficulty || 'medium';
      const secs = v.answer_time_seconds ? `~${v.answer_time_seconds}s` : '';

      return `
        <div class="docs-card-variant">
          <div class="docs-variant-meta">
            <span class="docs-variant-num">#${i + 1}</span>
            <span class="docs-variant-difficulty ${difficultyClass[diff] || ''}">${difficultyLabel[diff] || diff}</span>
            ${secs ? `<span class="docs-variant-time">${escHtml(secs)}</span>` : ''}
          </div>
          <div class="docs-variant-question">${escHtml(v.question)}</div>
          <details class="docs-variant-answer-wrap">
            <summary>Respuesta esperada</summary>
            <div class="docs-variant-answer">${escHtml(v.expected_answer)}</div>
          </details>
          ${rubricItems ? `
          <details class="docs-variant-rubric-wrap">
            <summary>Rúbrica de corrección</summary>
            <ul class="docs-variant-rubric">${rubricItems}</ul>
          </details>` : ''}
        </div>
      `;
    }).join('');

    panel.innerHTML = `
      <div class="docs-card-draft-header">
        <span class="docs-card-draft-title">${escHtml(data.card_group?.title || '')}</span>
        <span class="docs-card-draft-badge">draft</span>
      </div>
      <div class="docs-card-variants-list">${variantsHTML}</div>
      <div class="docs-card-draft-accept" data-card-id="${cardId}">
        <span class="docs-accept-label">Agregar a materia:</span>
        <input type="text"
          class="docs-accept-subject-input"
          list="docs-accept-subjects-${cardId}"
          placeholder="ej: Sistemas de Información"
          value="${escHtml(subjectDefault)}"
        >
        <datalist id="docs-accept-subjects-${cardId}"></datalist>
        <button type="button" class="btn-primary docs-accept-draft-btn">Agregar a materia</button>
        <span class="docs-accept-draft-status"></span>
      </div>
    `;
    panel.classList.remove('hidden');

    // Populate datalist with known subjects
    const datalist = panel.querySelector(`#docs-accept-subjects-${cardId}`);
    getJson('/api/cards/subjects').then(res => {
      if (datalist && res.subjects) {
        datalist.innerHTML = res.subjects.map(s => `<option value="${escHtml(s)}">`).join('');
      }
    }).catch(() => {});

    // Wire accept button
    panel.querySelector('.docs-accept-draft-btn').addEventListener('click', () => {
      const subject = panel.querySelector('.docs-accept-subject-input').value.trim();
      acceptCardDraftUI(cardId, subject, panel);
    });
  }

  // ── Toggle content viewer panel ───────────────────────────────────────────────
  async function toggleContentPanel(docId, item) {
    const panel  = item.querySelector('.docs-content-panel');
    const isOpen = !panel.classList.contains('hidden');

    if (isOpen) {
      panel.classList.add('hidden');
      panel.innerHTML = '';
      return;
    }

    panel.classList.remove('hidden');
    panel.innerHTML = '<span style="color:var(--text-muted);font-size:var(--fs-sm)">Cargando contenido...</span>';

    try {
      const data = await getJson(`/api/documents/${docId}/content`);
      const wordCountLabel = data.word_count != null ? ` · ${Number(data.word_count).toLocaleString('es-AR')} palabras` : '';
      panel.innerHTML = `
        <div class="docs-content-viewer">
          <div class="docs-content-viewer-meta">
            ${data.subject ? `<span>Materia: ${escHtml(data.subject)}</span>` : ''}
            <span>${escHtml(data.original_filename || 'Sin nombre')}${escHtml(wordCountLabel)}</span>
          </div>
          <pre class="docs-content-viewer-text">${escHtml(data.text || '(sin texto)')}</pre>
        </div>
      `;
    } catch (err) {
      panel.innerHTML = `<span style="color:var(--fail-fg);font-size:var(--fs-sm)">Error: ${escHtml(err.message)}</span>`;
    }
  }

  // ── Toggle exam loader panel ──────────────────────────────────────────────────
  function toggleExamLoadPanel(item) {
    const panel   = item.querySelector('.docs-exam-load-panel');
    const isOpen  = !panel.classList.contains('hidden');

    if (isOpen) {
      panel.classList.add('hidden');
      panel.innerHTML = '';
      return;
    }

    const subject = item.dataset.subject;
    if (!subject) return;

    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="docs-exam-load-form">
        <div class="docs-exam-load-title">Cargar examen de referencia — <em>${escHtml(subject)}</em></div>
        <div class="docs-exam-load-row">
          <input type="number" class="docs-exam-year-input" placeholder="Año (ej: 2023)" min="2000" max="2030" style="width:130px">
          <input type="text" class="docs-exam-label-input" placeholder="Ej: 2do Parcial 2023" style="flex:1">
          <select class="docs-exam-type-select">
            <option value="parcial">Parcial</option>
            <option value="final">Final</option>
          </select>
        </div>
        <textarea class="docs-exam-content-input" rows="5" placeholder="Pegá las preguntas del examen..."></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <button type="button" class="btn-primary docs-exam-submit-btn">Guardar examen</button>
          <button type="button" class="btn-ghost docs-exam-cancel-btn" style="font-size:var(--fs-sm)">Cancelar</button>
          <span class="docs-exam-load-feedback"></span>
        </div>
      </div>
    `;

    panel.querySelector('.docs-exam-cancel-btn').addEventListener('click', () => {
      panel.classList.add('hidden');
      panel.innerHTML = '';
    });

    panel.querySelector('.docs-exam-submit-btn').addEventListener('click', () => {
      const contentText = panel.querySelector('.docs-exam-content-input').value.trim();
      if (!contentText) {
        panel.querySelector('.docs-exam-load-feedback').textContent = 'El contenido no puede estar vacío.';
        return;
      }
      submitReferenceExam(
        subject,
        panel.querySelector('.docs-exam-year-input').value || null,
        panel.querySelector('.docs-exam-label-input').value.trim() || null,
        panel.querySelector('.docs-exam-type-select').value,
        contentText,
        panel
      );
    });
  }

  async function submitReferenceExam(subject, year, label, examType, contentText, panel) {
    const btn      = panel.querySelector('.docs-exam-submit-btn');
    const feedback = panel.querySelector('.docs-exam-load-feedback');

    btn.disabled    = true;
    btn.textContent = 'Guardando...';
    feedback.textContent = '';

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (Auth.getToken()) headers['Authorization'] = 'Bearer ' + Auth.getToken();

      const body = { content_text: contentText, exam_type: examType };
      if (year) body.year = Number(year);
      if (label) body.label = label;

      const res = await fetch(`/curriculum/${encodeURIComponent(subject)}/exams`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      Auth.handleRefreshToken(res);

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `HTTP ${res.status}`);

      feedback.textContent = `Examen guardado (${payload.exams?.length ?? 1} en total para "${subject}").`;
      feedback.style.color = 'var(--pass-fg)';
      panel.querySelector('.docs-exam-content-input').value = '';
      panel.querySelector('.docs-exam-year-input').value = '';
      panel.querySelector('.docs-exam-label-input').value = '';
    } catch (err) {
      feedback.textContent = err.message;
      feedback.style.color = 'var(--fail-fg)';
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Guardar examen';
    }
  }

  // ── Accept card draft → activate + assign subject ─────────────────────────────
  async function acceptCardDraftUI(cardId, subject, panel) {
    const btn      = panel.querySelector('.docs-accept-draft-btn');
    const statusEl = panel.querySelector('.docs-accept-draft-status');

    btn.disabled    = true;
    btn.textContent = 'Agregando...';
    statusEl.textContent = '';
    statusEl.className = 'docs-accept-draft-status';

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (Auth.getToken()) headers['Authorization'] = 'Bearer ' + Auth.getToken();

      const res = await fetch(`/api/cards/${cardId}/accept-draft`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ subject }),
      });
      Auth.handleRefreshToken(res);

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `HTTP ${res.status}`);

      const finalSubject = payload.card?.subject || subject;
      btn.textContent = finalSubject ? `Añadida a "${finalSubject}"` : 'Añadida';
      btn.classList.add('docs-accept-draft-btn--done');

      // Update the draft badge to "activa"
      const badge = panel.querySelector('.docs-card-draft-badge');
      if (badge) { badge.textContent = 'activa'; badge.classList.add('docs-card-draft-badge--active'); }

      // Hide the accept form inputs, leaving only the confirmation button
      panel.querySelector('.docs-accept-subject-input').style.display = 'none';
      panel.querySelector(`[id^="docs-accept-subjects-"]`).remove();
      panel.querySelector('.docs-accept-label').style.display = 'none';

      // Mark the parent cluster item as "cards added"
      const rankingItem = panel.closest('.docs-ranking-item');
      if (rankingItem) {
        rankingItem.classList.add('docs-ranking-item--cards-added');

        // Add badge in header if not already there
        const head = rankingItem.querySelector('.docs-ranking-item-head');
        if (head && !head.querySelector('.docs-cluster-added-badge')) {
          const addedBadge = document.createElement('span');
          addedBadge.className = 'docs-cluster-added-badge';
          addedBadge.innerHTML = '&#10003; Agregado';
          head.appendChild(addedBadge);
        }

        // Inject or update the log line
        const now       = new Date();
        const dateStr   = now.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const count     = payload.cards_added_count ?? 1;
        const countStr  = `${count} tarjeta${count !== 1 ? 's' : ''}`;
        const subjectStr = finalSubject
          ? ` → <em>${escHtml(finalSubject)}</em>`
          : '';
        let logEl = rankingItem.querySelector('.docs-cluster-added-log');
        if (!logEl) {
          logEl = document.createElement('div');
          logEl.className = 'docs-cluster-added-log';
          // Insert before the actions row
          const actionsRow = rankingItem.querySelector('.docs-ranking-item-actions');
          if (actionsRow) rankingItem.insertBefore(logEl, actionsRow);
          else rankingItem.appendChild(logEl);
        }
        logEl.innerHTML = `&#10003; Tarjetas agregadas el ${escHtml(dateStr)} &middot; ${countStr}${subjectStr}`;
      }
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'docs-accept-draft-status docs-accept-draft-status--error';
      btn.disabled = false;
      btn.textContent = 'Agregar a materia';
    }
  }

  // ── Create document ───────────────────────────────────────────────────────────
  createBtn.addEventListener('click', async () => {
    const text = textInput.value.trim();
    if (!text) {
      showToast('El texto no puede estar vacío.', 'error');
      return;
    }

    createBtn.disabled = true;

    try {
      await postJson('/api/documents', {
        text,
        original_filename: nameInput.value.trim() || null,
        subject: subjectInput.value.trim() || null,
      });

      textInput.value = '';
      nameInput.value = '';
      subjectInput.value = '';
      showToast('Documento creado.', 'success');

      await loadDocuments();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      createBtn.disabled = false;
    }
  });

  loadDocuments();
}

// ── Transcript semantic search tab ────────────────────────────────────────────

function initTranscriptsTab() {
  let selectedDocId   = null;

  const docsLoading = document.querySelector('#ts-docs-loading');
  const docsEmpty   = document.querySelector('#ts-docs-empty');
  const docsList    = document.querySelector('#ts-docs-list');
  const chatWrap    = document.querySelector('#ts-chat-wrap');
  const selectedLbl = document.querySelector('#ts-selected-doc-name');
  const messagesEl  = document.querySelector('#ts-chat-messages');
  const inputEl     = document.querySelector('#ts-chat-input');
  const sendBtn     = document.querySelector('#ts-chat-send');
  const topKEl      = document.querySelector('#ts-top-k');

  // ── Load document list ──────────────────────────────────────────────────────
  async function loadDocs() {
    try {
      const data = await getJson('/api/documents');
      docsLoading.classList.add('hidden');
      const docs = Array.isArray(data) ? data : (data.documents || []);
      if (!docs.length) { docsEmpty.classList.remove('hidden'); return; }

      docs.forEach(doc => {
        const docName = doc.original_filename || doc.name || 'Sin nombre';
        const el = document.createElement('div');
        el.className = 'ts-doc-item';
        el.dataset.docId = doc.id;
        el.innerHTML = `
          <span class="ts-doc-name">${escHtml(docName)}</span>
          ${doc.subject ? `<span class="ts-doc-subject">${escHtml(doc.subject)}</span>` : ''}
          <span class="ts-doc-active-badge hidden">Activo</span>
          <button class="ts-ingest-btn btn-ghost" title="Indexar transcript para búsqueda semántica">Indexar</button>
          <span class="ts-ingest-status"></span>
        `;
        el.querySelector('.ts-ingest-btn').addEventListener('click', e => {
          e.stopPropagation();
          ingestDoc(doc.id, el);
        });
        el.addEventListener('click', () => selectDoc(doc.id, docName, el));
        docsList.appendChild(el);
      });
    } catch {
      docsLoading.textContent = 'Error al cargar documentos.';
    }
  }

  // ── Ingest a document's transcript ─────────────────────────────────────────
  async function ingestDoc(id, rowEl) {
    const btn    = rowEl.querySelector('.ts-ingest-btn');
    const status = rowEl.querySelector('.ts-ingest-status');
    btn.disabled = true;
    status.textContent = 'Indexando…';
    status.style.color = 'var(--text-muted)';
    try {
      const content = await getJson(`/api/documents/${id}/content`);
      const raw = content.text || content.document_text || '';
      if (!raw.trim()) {
        status.textContent = 'Sin texto para indexar.';
        status.style.color = 'var(--fail-fg, #e53e3e)';
        btn.disabled = false;
        return;
      }
      const result = await postJson('/api/transcripts/ingest', { document_id: id, raw_text: raw });
      status.textContent = `✓ ${result.chunks_created} chunks`;
      status.style.color = 'var(--pass-fg, #38a169)';
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.style.color = 'var(--fail-fg, #e53e3e)';
      btn.disabled = false;
    }
  }

  // ── Select a document ───────────────────────────────────────────────────────
  function selectDoc(id, name, el) {
    docsList.querySelectorAll('.ts-doc-item').forEach(item => {
      item.classList.remove('ts-doc-item--active');
      item.querySelector('.ts-doc-active-badge').classList.add('hidden');
    });
    el.classList.add('ts-doc-item--active');
    el.querySelector('.ts-doc-active-badge').classList.remove('hidden');

    selectedDocId = id;
    selectedLbl.textContent = name;
    messagesEl.innerHTML = '';
    chatWrap.classList.remove('hidden');
    inputEl.focus();
  }

  // ── Render helpers ──────────────────────────────────────────────────────────
  function appendUserBubble(text) {
    const el = document.createElement('div');
    el.className = 'ts-bubble ts-bubble--user';
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendThinking() {
    const el = document.createElement('div');
    el.className = 'ts-bubble ts-bubble--thinking';
    el.textContent = 'Buscando…';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function appendResults(results) {
    if (!results.length) {
      const el = document.createElement('div');
      el.className = 'ts-bubble ts-bubble--empty';
      el.textContent = 'No se encontraron fragmentos relevantes.';
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'ts-results-wrap';

    results.forEach(r => {
      const pct = Math.round((r.similarity || 0) * 100);
      const tsLabel = r.timestamp_start
        ? (r.timestamp_end && r.timestamp_end !== r.timestamp_start
            ? `${r.timestamp_start} → ${r.timestamp_end}`
            : r.timestamp_start)
        : 'Sin timestamp';

      const card = document.createElement('div');
      card.className = 'ts-result-card';
      card.innerHTML = `
        <div class="ts-result-meta">
          <span class="ts-result-ts">${escHtml(tsLabel)}</span>
          <span class="ts-result-sim">${pct}% similitud</span>
        </div>
        <p class="ts-result-content">${escHtml(r.content)}</p>
        <div class="ts-result-bar" style="--pct:${pct}%"></div>
      `;
      wrap.appendChild(card);
    });

    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendError(msg) {
    const el = document.createElement('div');
    el.className = 'ts-bubble ts-bubble--error';
    el.textContent = msg;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  async function doSearch() {
    const query = inputEl.value.trim();
    if (!query || !selectedDocId) return;

    inputEl.value = '';
    sendBtn.disabled = true;
    inputEl.disabled = true;

    appendUserBubble(query);
    const thinking = appendThinking();

    try {
      const results = await postJson('/api/transcripts/search', {
        query,
        document_id: selectedDocId,
        top_k: Number(topKEl.value),
      });
      thinking.remove();
      appendResults(Array.isArray(results) ? results : []);
    } catch (err) {
      thinking.remove();
      appendError(`Error al buscar: ${err.message}`);
    } finally {
      sendBtn.disabled = false;
      inputEl.disabled = false;
      inputEl.focus();
    }
  }

  sendBtn.addEventListener('click', doSearch);
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSearch(); }
  });

  loadDocs();
}
