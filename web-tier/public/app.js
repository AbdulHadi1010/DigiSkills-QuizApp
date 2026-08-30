/**
 * DigiQuiz — WP1 — app.js
 * =============================================================================
 * Static student UI. Served from S3 through CloudFront. Talks to the public ALB.
 *
 * ZERO ANSWER LOGIC LIVES HERE.
 *   - The quiz payload this file renders contains only { id, label, option_text }
 *     per option. There is no is_correct field to read, because the app tier
 *     never selected that column.
 *   - The score on the results screen is whatever /api/quizzes/:id/submit
 *     returned. This file does not compute it, cannot verify it, and has no
 *     answer key to compare against.
 *   - Search this file for "correct": the only hits are UI copy.
 *
 * The JWT is kept in memory and mirrored to sessionStorage so a page refresh
 * does not sign the student out. It is sent as `Authorization: Bearer <token>`.
 * =============================================================================
 */

'use strict';

// =============================================================================
// CONFIGURATION — set this before uploading to S3
// =============================================================================
/**
 * Public API base URL: the DigiQuiz ALB, HTTPS.
 *   Production example: 'https://api.digiquiz.example.com'
 *   ALB DNS example:    'https://digiquiz-alb-1234567890.ap-south-1.elb.amazonaws.com'
 *   Local development:  'http://localhost:8080'
 * Leave as '' if CloudFront proxies /api/* to the ALB on the same origin.
 *
 * DEV BUNDLE: set to '' because in digiquiz-dev the web tier serves this file
 * itself, so the API is same-origin. In the AWS build this points at the ALB.
 */
const API_BASE = '';

/** Where the server-rendered admin console lives (web tier, not S3). */
const ADMIN_URL = API_BASE + '/admin';

// =============================================================================
// Tiny helpers
// =============================================================================
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

const state = {
  token: sessionStorage.getItem('dq_token') || null,
  user: null,            // { id, username, role } decoded from the token, display only
  quizzes: [],
  currentQuiz: null,     // the quiz being taken
  lastResult: null,      // { quizId, quizTitle, score, total }
};

function setToken(token) {
  state.token = token;
  if (token) sessionStorage.setItem('dq_token', token);
  else sessionStorage.removeItem('dq_token');
  state.user = token ? decodeToken(token) : null;
}

/**
 * Decode the token payload for DISPLAY ONLY (username in the header, whether to
 * show the Admin link). The browser cannot verify a signature and nothing here
 * grants access — every protected route is authorised server-side by the app
 * tier, which does verify.
 */
function decodeToken(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return { id: payload.id, username: payload.username, role: payload.role };
  } catch (e) {
    return null;
  }
}

let toastTimer = null;
function toast(message, kind) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (kind ? ' toast-' + kind : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

let loadingDepth = 0;
function setLoading(on) {
  loadingDepth = Math.max(0, loadingDepth + (on ? 1 : -1));
  $('#loading').hidden = loadingDepth === 0;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// =============================================================================
// API client
// =============================================================================
async function api(path, options) {
  const opts = options || {};
  const headers = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;

  setLoading(true);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (networkError) {
    setLoading(false);
    throw new Error('Could not reach the DigiQuiz API. Check your connection.');
  }
  setLoading(false);

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

  if (res.status === 401 && state.token) {
    // Token missing, expired or tampered with — the app tier rejected it.
    signOut('Your session expired. Please sign in again.');
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || ('Request failed (HTTP ' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return data;
}

// =============================================================================
// Navigation
// =============================================================================
const VIEWS = ['auth', 'quizzes', 'take', 'result', 'attempts', 'leaderboard'];

function show(view) {
  VIEWS.forEach((v) => { $('#view-' + v).hidden = (v !== view); });
  $$('.navlink').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === view));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function refreshChrome() {
  const signedIn = Boolean(state.token && state.user);
  $('#mainnav').hidden = !signedIn;
  $('#userbox').hidden = !signedIn;
  if (signedIn) {
    $('#uname').textContent = state.user.username;
    $('#avatar').textContent = (state.user.username[0] || '?').toUpperCase();
    $('#adminLink').hidden = state.user.role !== 'admin';
  }
}

function signOut(message) {
  setToken(null);
  refreshChrome();
  show('auth');
  if (message) toast(message, 'warn');
}

// =============================================================================
// F1 / F2 — register and login
// =============================================================================
function switchAuthTab(which) {
  const login = which === 'login';
  $('#tabLogin').classList.toggle('is-active', login);
  $('#tabRegister').classList.toggle('is-active', !login);
  $('#loginForm').hidden = !login;
  $('#registerForm').hidden = login;
  $('#loginErr').textContent = '';
  $('#regErr').textContent = '';
}

$('#tabLogin').addEventListener('click', () => switchAuthTab('login'));
$('#tabRegister').addEventListener('click', () => switchAuthTab('register'));

$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#loginErr').textContent = '';
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('#loginUser').value.trim(), password: $('#loginPass').value },
    });
    setToken(data.token);
    if (!state.user) throw new Error('The server returned a token this browser could not read.');
    $('#loginForm').reset();
    refreshChrome();
    toast('Welcome back, ' + state.user.username + '.', 'ok');
    await loadQuizzes();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
});

$('#registerForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#regErr').textContent = '';
  const username = $('#regUser').value.trim();
  const password = $('#regPass').value;

  if (password !== $('#regPass2').value) {
    $('#regErr').textContent = 'The two passwords do not match.';
    return;
  }
  if (password.length < 8) {
    $('#regErr').textContent = 'Password must be at least 8 characters.';
    return;
  }

  try {
    await api('/api/auth/register', { method: 'POST', body: { username, password } });
    // Registration succeeded — log straight in.
    const data = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    setToken(data.token);
    $('#registerForm').reset();
    refreshChrome();
    toast('Account created. You are signed in.', 'ok');
    await loadQuizzes();
  } catch (err) {
    $('#regErr').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', () => signOut('Signed out.'));

$('#adminLink').addEventListener('click', () => {
  // The admin console is server-rendered by the web tier (F8), not part of this
  // static bundle. Hand the token over in the query string; the web tier checks
  // the role before rendering and the app tier re-checks it on every write.
  window.location.href = ADMIN_URL + '?token=' + encodeURIComponent(state.token);
});

// =============================================================================
// F3 — quiz list
// =============================================================================
async function loadQuizzes() {
  try {
    state.quizzes = await api('/api/quizzes');
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }

  const grid = $('#quizGrid');
  grid.innerHTML = '';
  $('#quizEmpty').hidden = state.quizzes.length > 0;

  state.quizzes.forEach((quiz, i) => {
    const card = document.createElement('article');
    card.className = 'card quiz-card';
    card.style.setProperty('--i', i);
    card.innerHTML =
      '<div class="quiz-badge">' + escapeHtml(String(quiz.id)) + '</div>' +
      '<h3>' + escapeHtml(quiz.title) + '</h3>' +
      '<p>' + escapeHtml(quiz.description || '') + '</p>' +
      '<div class="quiz-actions">' +
        '<button class="btn btn-primary btn-sm start">Start quiz</button>' +
        '<button class="btn btn-ghost btn-sm board">Leaderboard</button>' +
      '</div>';

    card.querySelector('.start').addEventListener('click', () => startQuiz(quiz.id));
    card.querySelector('.board').addEventListener('click', () => showLeaderboard(quiz.id, quiz.title));
    grid.appendChild(card);
  });

  show('quizzes');
}

// =============================================================================
// F4 — take a quiz
// =============================================================================
async function startQuiz(quizId) {
  let quiz;
  try {
    quiz = await api('/api/quizzes/' + quizId);
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }

  state.currentQuiz = quiz;
  $('#takeTitle').textContent = quiz.title;
  $('#takeDesc').textContent = quiz.description || '';
  $('#takeErr').textContent = '';

  const list = $('#questionList');
  list.innerHTML = '';

  quiz.questions.forEach((q, qi) => {
    const block = document.createElement('fieldset');
    block.className = 'card question-card';
    block.style.setProperty('--i', qi);

    const options = q.options.map((o) => (
      '<label class="option">' +
        '<input type="radio" name="q' + q.id + '" value="' + o.id + '">' +
        '<span class="option-label">' + escapeHtml(o.label) + '</span>' +
        '<span class="option-text">' + escapeHtml(o.option_text) + '</span>' +
      '</label>'
    )).join('');

    block.innerHTML =
      '<legend><span class="qnum">Q' + (qi + 1) + '</span> ' + escapeHtml(q.stem) + '</legend>' +
      '<div class="options">' + options + '</div>';

    list.appendChild(block);
  });

  list.addEventListener('change', updateProgress);
  updateProgress();
  show('take');
}

function updateProgress() {
  if (!state.currentQuiz) return;
  const total = state.currentQuiz.questions.length;
  const answered = $$('#questionList input[type=radio]:checked').length;
  $('#progressBar').style.width = total ? (answered / total * 100) + '%' : '0%';
  $('#progressText').textContent = answered + ' of ' + total + ' answered';
  $$('.option').forEach((label) => {
    label.classList.toggle('is-picked', label.querySelector('input').checked);
  });
}

// =============================================================================
// F5 — submit and show the score
// =============================================================================
$('#takeForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!state.currentQuiz) return;
  $('#takeErr').textContent = '';

  // Collect { questionId, optionId } pairs. That is all the browser knows.
  const answers = state.currentQuiz.questions
    .map((q) => {
      const picked = document.querySelector('input[name="q' + q.id + '"]:checked');
      return picked ? { questionId: q.id, optionId: Number(picked.value) } : null;
    })
    .filter(Boolean);

  if (answers.length === 0) {
    $('#takeErr').textContent = 'Answer at least one question first.';
    return;
  }
  if (answers.length < state.currentQuiz.questions.length) {
    const missing = state.currentQuiz.questions.length - answers.length;
    if (!window.confirm(missing + ' question(s) are unanswered. Submit anyway?')) return;
  }

  const btn = $('#submitQuizBtn');
  btn.disabled = true;
  try {
    // The server grades this. The response is { score, total } — nothing else.
    const result = await api('/api/quizzes/' + state.currentQuiz.id + '/submit', {
      method: 'POST',
      body: { answers: answers },
    });
    state.lastResult = {
      quizId: state.currentQuiz.id,
      quizTitle: state.currentQuiz.title,
      score: result.score,
      total: result.total,
    };
    renderResult(state.lastResult);
  } catch (err) {
    $('#takeErr').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function renderResult(result) {
  const pct = result.total ? Math.round((result.score / result.total) * 100) : 0;

  $('#resultQuiz').textContent = result.quizTitle;
  $('#resultScore').textContent = result.score;
  $('#resultTotal').textContent = '/ ' + result.total;
  $('#resultPct').textContent = pct + '%';

  const ring = $('#scoreRing');
  ring.style.setProperty('--pct', pct);
  ring.dataset.band = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';

  $('#resultMsg').textContent =
    pct === 100 ? 'Perfect score. Nothing left to teach you here.' :
    pct >= 80   ? 'Strong result — you clearly know this material.' :
    pct >= 50   ? 'Solid, with room to improve. Worth another go.' :
                  'Worth reviewing this topic and retaking the quiz.';

  show('result');
}

$('#resultLeaderboardBtn').addEventListener('click', () => {
  if (state.lastResult) showLeaderboard(state.lastResult.quizId, state.lastResult.quizTitle);
});

// =============================================================================
// F6 — my past attempts
// =============================================================================
async function loadAttempts() {
  let attempts;
  try {
    attempts = await api('/api/me/attempts');
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }

  const body = $('#attemptsBody');
  body.innerHTML = '';
  $('#attemptsEmpty').hidden = attempts.length > 0;

  attempts.forEach((a) => {
    const pct = a.total ? Math.round((a.score / a.total) * 100) : 0;
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + escapeHtml(a.quizTitle) + '</td>' +
      '<td class="num"><span class="pill pill-' +
        (pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low') + '">' +
        escapeHtml(String(a.score)) + '</span></td>' +
      '<td class="num">' + escapeHtml(String(a.total)) + '</td>' +
      '<td>' + escapeHtml(formatDate(a.takenAt)) + '</td>';
    body.appendChild(tr);
  });

  show('attempts');
}

// =============================================================================
// F7 — leaderboard
// =============================================================================
async function showLeaderboard(quizId, quizTitle) {
  let rows;
  try {
    rows = await api('/api/quizzes/' + quizId + '/leaderboard');
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }

  $('#lbTitle').textContent = (quizTitle || 'Quiz') + ' — leaderboard';
  const list = $('#leaderboardList');
  list.innerHTML = '';
  $('#lbEmpty').hidden = rows.length > 0;

  rows.forEach((row, i) => {
    const li = document.createElement('li');
    li.className = 'lb-row' + (i < 3 ? ' lb-top lb-' + (i + 1) : '');
    li.style.setProperty('--i', i);
    const isMe = state.user && row.username === state.user.username;
    li.innerHTML =
      '<span class="lb-rank">' + (i + 1) + '</span>' +
      '<span class="lb-name">' + escapeHtml(row.username) + (isMe ? ' <em>(you)</em>' : '') + '</span>' +
      '<span class="lb-score">' + escapeHtml(String(row.score)) + '</span>';
    list.appendChild(li);
  });

  show('leaderboard');
}

// =============================================================================
// Wiring + boot
// =============================================================================
document.addEventListener('click', (ev) => {
  const target = ev.target.closest('[data-nav]');
  if (!target) return;
  ev.preventDefault();
  const dest = target.dataset.nav;
  if (dest === 'quizzes') loadQuizzes();
  else if (dest === 'attempts') loadAttempts();
  else show(dest);
});

(function boot() {
  if (state.token) {
    state.user = decodeToken(state.token);
    if (!state.user) setToken(null);   // stale or unreadable — start clean
  }
  refreshChrome();

  if (state.token) {
    loadQuizzes();
  } else {
    switchAuthTab('login');
    show('auth');
  }

  if (API_BASE.indexOf('REPLACE-ME') !== -1) {
    toast('Set API_BASE at the top of app.js before deploying.', 'warn');
  }
})();
