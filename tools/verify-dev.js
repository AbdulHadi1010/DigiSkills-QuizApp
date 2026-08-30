#!/usr/bin/env node
/**
 * DigiQuiz dev bundle — tools/verify-dev.js
 * =============================================================================
 * Boots Path B on scratch ports against a throwaway SQLite file, drives the
 * whole student and admin journey through the WEB TIER (never straight to the
 * app tier), asserts the security invariants, then tears everything down.
 *
 *   npm run verify
 *
 * Runs on Windows, macOS and Linux — it is Node, not bash, precisely so the
 * Windows user can re-run it.
 *
 * Exit code 0 = everything passed.
 * =============================================================================
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.VERIFY_APP_PORT || 4999);
const WEB_PORT = Number(process.env.VERIFY_WEB_PORT || 8999);
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const SQLITE_FILE = path.join(os.tmpdir(), `digiquiz-verify-${process.pid}.sqlite`);

let pass = 0;
let fail = 0;
const failures = [];

const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const bad = (msg) => { fail += 1; failures.push(msg); console.log(`  FAIL  ${msg}`); };
const head = (msg) => console.log(`\n== ${msg} ${'='.repeat(Math.max(0, 60 - msg.length))}`);

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(`${label} (${a})`);
  else bad(`${label} — expected ${e}, got ${a}`);
}

// -----------------------------------------------------------------------------
// Process management
// -----------------------------------------------------------------------------
const children = [];
function start(label, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  children.push(child);
  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n[verify] ${label} exited with code ${code}:\n${log.join('')}`);
    }
  });
  child._log = log;
  return child;
}

function stopAll() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  try { fs.rmSync(SQLITE_FILE, { force: true }); } catch { /* ignore */ }
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(SQLITE_FILE + suffix, { force: true }); } catch { /* ignore */ }
  }
}
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// -----------------------------------------------------------------------------
// HTTP helper — everything goes through the web tier
// -----------------------------------------------------------------------------
async function api(method, urlPath, { token, body, raw } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* not json */ } }
  return { status: res.status, json, text };
}

// -----------------------------------------------------------------------------
(async function main() {
  console.log('DigiQuiz dev bundle — end-to-end verification (Path B, SQLite)\n');
  console.log(`  node        ${process.version}`);
  console.log(`  scratch db  ${SQLITE_FILE}`);
  console.log(`  web tier    ${BASE}`);

  head('0. Static checks');
  try {
    require('node:sqlite');
    ok('node:sqlite is available — Path B needs no native module');
  } catch {
    bad('node:sqlite unavailable (Node 22.5+ required, or install better-sqlite3)');
  }
  const webSrc = fs.readFileSync(path.join(ROOT, 'web-tier', 'web-server.js'), 'utf8');
  const codeLines = (src, needle) =>
    src.split('\n').filter((l) => l.includes(needle) && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
  check('web tier requires no DB driver', /require\(['"](mysql2?|mariadb|sqlite)/.test(webSrc), false);
  check('web tier requires no JWT library', /require\(['"]jsonwebtoken/.test(webSrc), false);
  check('web tier has no SQL', codeLines(webSrc, 'SELECT ') + codeLines(webSrc, 'INSERT INTO'), 0);
  const feSrc = fs.readFileSync(path.join(ROOT, 'web-tier', 'public', 'app.js'), 'utf8');
  check('browser bundle has no is_correct in code', codeLines(feSrc, 'is_correct'), 0);
  check('browser bundle uses same-origin API base', /const API_BASE = '';/.test(feSrc), true);

  head('1. Boot both tiers');
  start('app', path.join(ROOT, 'app-tier', 'app-server.js'), {
    PORT: String(APP_PORT),
    DB_ENGINE: 'sqlite',
    SQLITE_FILE,
    SQLITE_SEED: path.join(ROOT, 'sql', 'digiquiz.sqlite.sql'),
    JWT_SECRET: 'verify-only-secret',
    NODE_ENV: 'development',
  });
  if (!(await waitFor(`http://127.0.0.1:${APP_PORT}/health`))) {
    bad('app tier failed to become healthy');
    console.error(children[0]._log.join(''));
    process.exit(1);
  }
  const appHealth = await (await fetch(`http://127.0.0.1:${APP_PORT}/health`)).json();
  check('app tier /health', appHealth, { status: 'ok', tier: 'app', db: 'up' });

  start('web', path.join(ROOT, 'web-tier', 'web-server.js'), {
    PORT: String(WEB_PORT),
    APP_URL: `http://127.0.0.1:${APP_PORT}`,
    PUBLIC_API_BASE: '',
    SERVE_STATIC_DIR: path.join(ROOT, 'web-tier', 'public'),
    NODE_ENV: 'development',
  });
  if (!(await waitFor(`${BASE}/health`))) {
    bad('web tier failed to become healthy');
    console.error(children[1]._log.join(''));
    process.exit(1);
  }
  check('web tier /health', (await api('GET', '/health')).json, { status: 'ok', tier: 'web' });

  head('2. Seed data loaded from digiquiz.sqlite.sql');
  const quizzes = await api('GET', '/api/quizzes');
  check('GET /api/quizzes returns 3 quizzes', quizzes.json.length, 3);
  check('quiz list fields', Object.keys(quizzes.json[0]).sort(), ['description', 'id', 'title']);
  check('quiz 1 title', quizzes.json[0].title, 'Load Balancing Basics');

  head('3. F1 register / F2 login');
  const reg = await api('POST', '/api/auth/register', {
    body: { username: 'verifyuser', password: 'Passw0rd!' },
  });
  check('register -> 201', reg.status, 201);
  check('register echoes username', reg.json.username, 'verifyuser');
  check('register response has no password field', /password/i.test(reg.text), false);
  check('duplicate register -> 409',
    (await api('POST', '/api/auth/register', { body: { username: 'verifyuser', password: 'Passw0rd!' } })).status, 409);
  check('short password -> 400',
    (await api('POST', '/api/auth/register', { body: { username: 'shorty', password: 'abc' } })).status, 400);

  const login = await api('POST', '/api/auth/login', { body: { username: 'verifyuser', password: 'Passw0rd!' } });
  check('login -> 200', login.status, 200);
  const TOKEN = login.json.token;
  check('login returns a 3-part JWT', String(TOKEN).split('.').length, 3);
  const claims = JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64url').toString());
  check('self-registered role is student', claims.role, 'student');

  // The seeded demo accounts must work with the passwords printed in DEV-README
  for (const [u, p] of [['student_demo', 'Passw0rd!'], ['ali', 'Passw0rd!'], ['admin', 'Admin123!']]) {
    const r = await api('POST', '/api/auth/login', { body: { username: u, password: p } });
    if (r.status === 200 && r.json.token) ok(`seeded account "${u}" logs in with the documented password`);
    else bad(`seeded account "${u}" could not log in with "${p}" (status ${r.status})`);
  }
  const ADMIN = (await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Admin123!' } })).json.token;
  check('admin token carries role=admin',
    JSON.parse(Buffer.from(ADMIN.split('.')[1], 'base64url').toString()).role, 'admin');

  head('4. F4 quiz read — THE ANSWER-KEY LEAK TEST');
  check('quiz read without a token -> 401', (await api('GET', '/api/quizzes/1')).status, 401);
  const quiz = await api('GET', '/api/quizzes/1', { token: TOKEN });
  check('quiz read -> 200', quiz.status, 200);
  check('quiz 1 has 5 questions', quiz.json.questions.length, 5);
  check('every question has 4 options', [...new Set(quiz.json.questions.map((q) => q.options.length))], [4]);
  check('grep is_correct on the response body', (quiz.text.match(/is_correct/gi) || []).length, 0);
  check('option keys are exactly id/label/option_text',
    [...new Set(quiz.json.questions.flatMap((q) => q.options.flatMap((o) => Object.keys(o))))].sort(),
    ['id', 'label', 'option_text']);
  check('no booleans anywhere in the payload', /\b(true|false)\b/.test(quiz.text), false);

  let sweepLeaks = 0;
  for (const p of ['/api/quizzes', '/api/quizzes/1', '/api/quizzes/2', '/api/quizzes/3',
                   '/api/me/attempts', '/api/quizzes/1/leaderboard']) {
    const r = await api('GET', p, { token: TOKEN });
    const n = (r.text.match(/is_correct/gi) || []).length;
    console.log(`        ${p.padEnd(32)} is_correct hits: ${n}`);
    sweepLeaks += n;
  }
  check('all endpoints leak-free', sweepLeaks, 0);

  head('5. F5 grading happens in the app tier');
  const allCorrect = {
    answers: [
      { questionId: 101, optionId: 1013 }, { questionId: 102, optionId: 1022 },
      { questionId: 103, optionId: 1031 }, { questionId: 104, optionId: 1042 },
      { questionId: 105, optionId: 1053 },
    ],
  };
  check('all-correct submission', (await api('POST', '/api/quizzes/1/submit', { token: TOKEN, body: allCorrect })).json,
    { score: 5, total: 5 });
  check('partial submission', (await api('POST', '/api/quizzes/1/submit', {
    token: TOKEN,
    body: { answers: [
      { questionId: 101, optionId: 1013 }, { questionId: 102, optionId: 1021 },
      { questionId: 103, optionId: 1031 }, { questionId: 104, optionId: 1041 },
      { questionId: 105, optionId: 1051 }] },
  })).json, { score: 2, total: 5 });
  check('option ids from another quiz score 0', (await api('POST', '/api/quizzes/1/submit', {
    token: TOKEN, body: { answers: [{ questionId: 101, optionId: 2011 }] },
  })).json, { score: 0, total: 5 });

  head('6. F6 attempts scoped by token / F7 leaderboard');
  const attempts = await api('GET', '/api/me/attempts', { token: TOKEN });
  check('attempt fields', Object.keys(attempts.json[0]).sort(), ['quizTitle', 'score', 'takenAt', 'total']);
  check('3 attempts recorded', attempts.json.length, 3);
  check('takenAt parses as a date', Number.isNaN(Date.parse(attempts.json[0].takenAt)), false);

  const other = await api('POST', '/api/auth/register', { body: { username: 'verifyuserb', password: 'Passw0rd!' } });
  check('second user registered', other.status, 201);
  const TOKEN_B = (await api('POST', '/api/auth/login', { body: { username: 'verifyuserb', password: 'Passw0rd!' } })).json.token;
  await api('POST', '/api/quizzes/2/submit', { token: TOKEN_B, body: { answers: [{ questionId: 201, optionId: 2011 }] } });

  const mineOnly = await api('GET', '/api/me/attempts', { token: TOKEN });
  const withInjection = await api('GET', '/api/me/attempts?user_id=2&userId=2', { token: TOKEN });
  check('injected user_id query params change nothing', mineOnly.text === withInjection.text, true);
  check('user A cannot see user B rows',
    mineOnly.json.filter((a) => a.quizTitle === 'CloudWatch Monitoring').length, 0);
  check('user B sees only their own attempt',
    (await api('GET', '/api/me/attempts', { token: TOKEN_B })).json.length, 1);

  const lb = await api('GET', '/api/quizzes/1/leaderboard');
  check('leaderboard fields', Object.keys(lb.json[0]).sort(), ['score', 'username']);
  check('leaderboard shows the best score, one row per user',
    lb.json.filter((r) => r.username === 'verifyuser').length, 1);
  check('best score is 5', lb.json.find((r) => r.username === 'verifyuser').score, 5);

  head('7. Auth negatives');
  check('no token -> 401', (await api('GET', '/api/me/attempts')).status, 401);
  check('garbage token -> 401', (await api('GET', '/api/me/attempts', { token: 'aaa.bbb.ccc' })).status, 401);
  const forged = (() => {
    const parts = TOKEN.split('.');
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    p.role = 'admin';
    parts[1] = Buffer.from(JSON.stringify(p)).toString('base64url');
    return parts.join('.');
  })();
  check('tampered role=admin -> 401', (await api('GET', '/api/me/attempts', { token: forged })).status, 401);
  const algNone = (() => {
    const p = JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64url').toString());
    p.role = 'admin';
    return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${
      Buffer.from(JSON.stringify(p)).toString('base64url')}.`;
  })();
  check('alg:none -> 401', (await api('GET', '/api/me/attempts', { token: algNone })).status, 401);
  check('SQL injection on login -> 401', (await api('POST', '/api/auth/login', {
    body: { username: "admin' OR '1'='1", password: 'x' },
  })).status, 401);
  check('SQL injection on quiz id -> 400',
    (await api('GET', '/api/quizzes/1;DROP%20TABLE%20users', { token: TOKEN })).status, 400);
  check('users table survived', (await api('GET', '/api/quizzes')).json.length >= 3, true);

  head('8. F8 admin');
  const studentAdmin = await api('POST', '/api/admin/quizzes', {
    token: TOKEN,
    body: { title: 'sneak', questions: [{ stem: 's', options: [
      { label: 'A', text: 'a', isCorrect: true }, { label: 'B', text: 'b' }] }] },
  });
  check('student blocked from the admin route -> 403', studentAdmin.status, 403);
  check('no token on the admin route -> 401', (await api('POST', '/api/admin/quizzes', {
    body: { title: 'x', questions: [] },
  })).status, 401);

  const before = (await api('GET', '/api/quizzes')).json.length;
  const created = await api('POST', '/api/admin/quizzes', {
    token: ADMIN,
    body: {
      title: 'VPC Fundamentals',
      description: 'Subnets, route tables and gateways.',
      questions: [
        { stem: 'What does a NAT Gateway provide?', options: [
          { label: 'A', text: 'Inbound access to private instances', isCorrect: false },
          { label: 'B', text: 'Outbound-only internet for private subnets', isCorrect: true },
          { label: 'C', text: 'Private DNS resolution', isCorrect: false },
          { label: 'D', text: 'VPC peering', isCorrect: false }] },
        { stem: 'What makes a subnet public?', options: [
          { label: 'A', text: 'A route to an Internet Gateway', isCorrect: true },
          { label: 'B', text: 'A public IP on one instance', isCorrect: false },
          { label: 'C', text: 'A NAT Gateway in the subnet', isCorrect: false },
          { label: 'D', text: 'An open security group', isCorrect: false }] },
      ],
    },
  });
  check('admin creates a quiz -> 201', created.status, 201);
  if (created.status !== 201) {
    console.log(`        app tier said: ${created.text}`);
    console.log(`        app tier log:\n${children[0]._log.join('').split('\n').slice(-12).map((l) => `          ${l}`).join('\n')}`);
  }
  const newId = created.json && created.json.id;
  check('new quiz appears in the list', (await api('GET', '/api/quizzes')).json.length, before + 1);
  const readBack = newId ? await api('GET', `/api/quizzes/${newId}`, { token: TOKEN }) : { json: { questions: [] }, text: '' };
  check('new quiz has 2 questions', readBack.json.questions.length, 2);
  check('new quiz read back has no is_correct', (readBack.text.match(/is_correct/gi) || []).length, 0);

  const beforeRollback = (await api('GET', '/api/quizzes')).json.length;
  check('two correct options rejected -> 400', (await api('POST', '/api/admin/quizzes', {
    token: ADMIN,
    body: { title: 'rollback probe', questions: [
      { stem: 'good', options: [{ label: 'A', text: 'a', isCorrect: true }, { label: 'B', text: 'b' }] },
      { stem: 'bad', options: [{ label: 'A', text: 'a', isCorrect: true }, { label: 'B', text: 'b', isCorrect: true }] }] },
  })).status, 400);
  check('transaction rolled back — quiz count unchanged',
    (await api('GET', '/api/quizzes')).json.length, beforeRollback);

  head('9. F8 /admin is server-rendered by the web tier');
  check('/admin with no token -> 302', (await api('GET', '/admin', { raw: true })).status, 302);
  const studentAdminPage = await api('GET', `/admin?token=${encodeURIComponent(TOKEN)}`, { raw: true });
  check('/admin with a student token -> 302', studentAdminPage.status, 302);
  check('redirect reason is not_admin',
    /not_admin/.test(studentAdminPage.headers.get('location') || ''), true);
  const adminPage = await api('GET', `/admin?token=${encodeURIComponent(ADMIN)}`, { raw: true });
  check('/admin with an admin token -> 200', adminPage.status, 200);
  check('/admin returns HTML', /text\/html/.test(adminPage.headers.get('content-type') || ''), true);
  check('rendered server-side with the username', /signed in as <b>admin<\/b>/.test(adminPage.text), true);
  check('no unsubstituted template placeholders', /\{\{/.test(adminPage.text), false);

  head('10. DEV ONLY — web tier serves the static UI (stands in for S3/CloudFront)');
  const index = await api('GET', '/', { raw: true });
  check('GET / -> 200', index.status, 200);
  check('GET / is the DigiQuiz UI', /<title>DigiQuiz<\/title>/.test(index.text), true);
  check('GET /app.js -> 200', (await api('GET', '/app.js', { raw: true })).status, 200);
  check('GET /style.css -> 200', (await api('GET', '/style.css', { raw: true })).status, 200);
  check('static files do not shadow the API',
    (await api('GET', '/api/quizzes', { raw: true })).status, 200);

  head('RESULT');
  console.log(`  passed: ${pass}`);
  console.log(`  failed: ${fail}`);
  if (fail) {
    console.log('\n  Failures:');
    failures.forEach((f) => console.log(`    - ${f}`));
  } else {
    console.log('\n  ALL CHECKS PASSED');
  }
  stopAll();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n[verify] harness error:', err);
  stopAll();
  process.exit(1);
});
