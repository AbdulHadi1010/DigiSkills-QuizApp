/**
 * DigiQuiz — WP2 — web-server.js
 * =============================================================================
 * PUBLIC WEB TIER.  Runs on EC2 instances in the public/web subnets
 * (10.0.1.0/24 / 10.0.11.0/24) inside an ASG, registered to the internet-facing
 * ALB target group.  Listens on port 80.
 *
 * What this tier does
 * -----------------------------------------------------------------------------
 *   1. Terminates every public /api/* call, validates the SHAPE of the input,
 *      forwards it to the private app tier at process.env.APP_URL, and relays the
 *      app tier's status code and JSON back to the caller faithfully.
 *   2. Passes the `authorization` header straight through, untouched.
 *   3. Server-renders GET /admin (F8) and serves it as HTML.  This is the ONLY
 *      HTML this tier produces; the student UI is static on S3/CloudFront.
 *   4. Answers GET /health for the ALB target group + ASG health check.
 *
 * What this tier CANNOT do, by construction
 * -----------------------------------------------------------------------------
 *   - It has no database client.  `mysql2` is not in its package.json.  There is
 *     no connection string, no DB credentials, no DB security-group path.
 *   - It never sees `is_correct`.  It cannot grade a quiz even if asked to.
 *   - It has no JWT signing key (see WP5 §5), so it cannot mint or verify tokens.
 *     The /admin gate below DECODES the token for a redirect decision only; the
 *     authoritative signature check and role check happen in the app tier.
 * =============================================================================
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '80', 10);

// The private app tier. Set to the internal ALB DNS name, or to the app-tier
// instance/NLB address. NEVER a public address.
const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');

// Where the browser should send API calls from the server-rendered admin page.
// Normally the public ALB origin; defaults to same-origin.
const PUBLIC_API_BASE = process.env.PUBLIC_API_BASE || '';

// CloudFront/S3 origin allowed to call this API from a browser.
// e.g. https://d111111abcdef8.cloudfront.net
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '8000', 10);

const ADMIN_TEMPLATE = path.join(__dirname, 'admin.html');

// *** DEV-ONLY, DIFFERS FROM THE AWS BUILD ***
// When SERVE_STATIC_DIR is set, this tier also serves index.html / app.js /
// style.css, standing in for S3 + CloudFront. That gives the dev stack a single
// origin, so there is no CORS hop and a phone only needs one URL.
// On AWS this variable is UNSET: the static UI lives in a private S3 bucket
// behind CloudFront, and this tier serves exactly one HTML page — /admin.
// Setting it changes nothing about the API routes below.
const SERVE_STATIC_DIR = process.env.SERVE_STATIC_DIR || '';

// -----------------------------------------------------------------------------
// App + global middleware
// -----------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind the ALB — makes req.ip / X-Forwarded-For sane
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// CORS — the student UI is served from CloudFront, a different origin to the ALB.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        tier: 'web',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
      })
    );
  });
  next();
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Forward a request to the private app tier and relay the response faithfully.
 *
 * - The `authorization` header is passed through byte-for-byte. This tier does
 *   not read it, rewrite it, or cache it.
 * - The upstream status code is relayed as-is: a 401 stays a 401, a 403 stays a
 *   403, a 409 stays a 409. The web tier never invents its own success.
 */
async function forward(req, res, { method, upstreamPath, body }) {
  const url = `${APP_URL}${upstreamPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  const headers = { Accept: 'application/json' };
  if (req.headers.authorization) {
    headers.Authorization = req.headers.authorization; // <- straight through
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Preserve the real client IP for the app tier's logs.
  headers['X-Forwarded-For'] = req.headers['x-forwarded-for'] || req.ip || '';

  try {
    const upstream = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await upstream.text();
    res.status(upstream.status);

    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      res.type('application/json').send(text);
    } else {
      res.type(contentType || 'text/plain').send(text);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[web] upstream timeout', { url });
      return fail(res, 504, 'Application tier timed out');
    }
    console.error('[web] upstream error', { url, code: err.code, message: err.message });
    return fail(res, 502, 'Application tier unavailable');
  } finally {
    clearTimeout(timer);
  }
}

/** Reject anything that is not a non-empty string within a length bound. */
function badString(value, min, max) {
  return typeof value !== 'string' || value.trim().length < min || value.length > max;
}

/** Minimal cookie reader — avoids pulling in cookie-parser for one cookie. */
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/**
 * Decode a JWT payload WITHOUT verifying the signature.
 *
 * This is deliberate and it is safe *for this one use*: deciding whether to
 * render the admin page or redirect to login. The web tier holds no signing key
 * (WP5 §5), so it cannot verify. A user who forges `"role":"admin"` in an
 * unsigned token can make this tier render the HTML form — and then every write
 * that form issues is rejected by the app tier's requireAuth + requireAdmin,
 * which DO verify the signature. Rendering a form is not an authorisation.
 */
function decodeJwtPayloadUnverified(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims = JSON.parse(json);
    if (claims.exp && Date.now() / 1000 > claims.exp) return null; // visibly expired
    return claims;
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// =============================================================================
// HEALTH
// =============================================================================
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', tier: 'web' });
});

/** Optional deep check — confirms this instance can reach the app tier. */
app.get(
  '/health/deep',
  wrap(async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const upstream = await fetch(`${APP_URL}/health`, { signal: controller.signal });
      return res
        .status(upstream.ok ? 200 : 503)
        .json({ status: upstream.ok ? 'ok' : 'degraded', tier: 'web', appTier: upstream.status });
    } catch {
      return res.status(503).json({ status: 'degraded', tier: 'web', appTier: 'unreachable' });
    } finally {
      clearTimeout(timer);
    }
  })
);

// =============================================================================
// PUBLIC API  →  PRIVATE APP TIER
// =============================================================================

// ---- F1  POST /api/auth/register  →  /register ------------------------------
app.post(
  '/api/auth/register',
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (badString(username, 3, 50)) return fail(res, 400, 'username must be 3-50 characters');
    if (badString(password, 8, 200)) return fail(res, 400, 'password must be at least 8 characters');
    if (!/^[A-Za-z0-9_.-]+$/.test(username.trim())) {
      return fail(res, 400, 'username may contain only letters, digits, _ . -');
    }
    // Note: only username and password are forwarded. A "role" field in the body
    // is dropped here, and would be ignored by the app tier anyway.
    return forward(req, res, {
      method: 'POST',
      upstreamPath: '/register',
      body: { username: username.trim(), password },
    });
  })
);

// ---- F2  POST /api/auth/login  →  /login ------------------------------------
app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (badString(username, 1, 50) || badString(password, 1, 200)) {
      return fail(res, 400, 'username and password are required');
    }
    return forward(req, res, {
      method: 'POST',
      upstreamPath: '/login',
      body: { username: username.trim(), password },
    });
  })
);

// ---- F3  GET /api/quizzes  →  /quizzes --------------------------------------
app.get(
  '/api/quizzes',
  wrap(async (req, res) => forward(req, res, { method: 'GET', upstreamPath: '/quizzes' }))
);

// ---- F7  GET /api/quizzes/:id/leaderboard  →  /quizzes/:id/leaderboard ------
// Declared before /api/quizzes/:id so the more specific path wins.
app.get(
  '/api/quizzes/:id/leaderboard',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 400, 'Invalid quiz id');
    const limit = parseId(req.query.limit) || 10;
    return forward(req, res, {
      method: 'GET',
      upstreamPath: `/quizzes/${id}/leaderboard?limit=${Math.min(limit, 100)}`,
    });
  })
);

// ---- F4  GET /api/quizzes/:id  →  /quizzes/:id ------------------------------
// The response is relayed verbatim. It contains no is_correct because the app
// tier never selected that column. This tier adds nothing and strips nothing.
app.get(
  '/api/quizzes/:id',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 400, 'Invalid quiz id');
    if (!req.headers.authorization) return fail(res, 401, 'Missing Authorization header');
    return forward(req, res, { method: 'GET', upstreamPath: `/quizzes/${id}` });
  })
);

// ---- F5  POST /api/quizzes/:id/submit  →  /quizzes/:id/grade ----------------
// Shape validation only. This tier has no idea which answers are correct, and
// that is the point: grading is impossible here.
app.post(
  '/api/quizzes/:id/submit',
  wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 400, 'Invalid quiz id');
    if (!req.headers.authorization) return fail(res, 401, 'Missing Authorization header');

    let { answers } = req.body || {};
    if (answers && !Array.isArray(answers) && typeof answers === 'object') {
      answers = Object.entries(answers).map(([questionId, optionId]) => ({
        questionId: Number(questionId),
        optionId: Number(optionId),
      }));
    }
    if (!Array.isArray(answers) || answers.length === 0 || answers.length > 200) {
      return fail(res, 400, 'answers must be a non-empty array of { questionId, optionId }');
    }
    for (const a of answers) {
      if (!parseId(a && a.questionId) || !parseId(a && a.optionId)) {
        return fail(res, 400, 'each answer needs positive integer questionId and optionId');
      }
    }

    return forward(req, res, {
      method: 'POST',
      upstreamPath: `/quizzes/${id}/grade`,
      body: {
        answers: answers.map((a) => ({
          questionId: Number(a.questionId),
          optionId: Number(a.optionId),
        })),
      },
    });
  })
);

// ---- F6  GET /api/me/attempts  →  /attempts ---------------------------------
// No user id travels on this route. The app tier derives it from the token.
app.get(
  '/api/me/attempts',
  wrap(async (req, res) => {
    if (!req.headers.authorization) return fail(res, 401, 'Missing Authorization header');
    return forward(req, res, { method: 'GET', upstreamPath: '/attempts' });
  })
);

// ---- F8  POST /api/admin/quizzes  →  /admin/quizzes -------------------------
// Shape validation here; the authoritative admin-role check is in the app tier.
app.post(
  '/api/admin/quizzes',
  wrap(async (req, res) => {
    if (!req.headers.authorization) return fail(res, 401, 'Missing Authorization header');

    const { title, description, questions } = req.body || {};
    if (badString(title, 1, 150)) return fail(res, 400, 'title is required (1-150 characters)');
    if (description != null && (typeof description !== 'string' || description.length > 500)) {
      return fail(res, 400, 'description must be at most 500 characters');
    }
    if (!Array.isArray(questions) || questions.length === 0 || questions.length > 100) {
      return fail(res, 400, 'questions must be a non-empty array');
    }
    for (const [i, q] of questions.entries()) {
      if (!q || badString(q.stem, 1, 500)) {
        return fail(res, 400, `questions[${i}].stem is required (1-500 characters)`);
      }
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
        return fail(res, 400, `questions[${i}] must have 2-4 options`);
      }
      const correct = q.options.filter((o) => o && (o.isCorrect === true || o.is_correct === true));
      if (correct.length !== 1) {
        return fail(res, 400, `questions[${i}] must have exactly one correct option`);
      }
      for (const [j, o] of q.options.entries()) {
        const text = o && (o.text != null ? o.text : o.option_text);
        if (badString(text, 1, 300)) {
          return fail(res, 400, `questions[${i}].options[${j}].text is required (1-300 characters)`);
        }
      }
    }

    return forward(req, res, {
      method: 'POST',
      upstreamPath: '/admin/quizzes',
      body: { title, description, questions },
    });
  })
);

// =============================================================================
// F8 — GET /admin : server-rendered by THIS tier (not S3), admin only
// =============================================================================
/**
 * The web tier renders the console; it does not touch the database. Every write
 * the rendered page performs goes Web → App → RDS like everything else.
 *
 * Token sources, in order: Authorization header, `dq_token` cookie, `?token=`
 * query parameter (that last one is how the static UI hands off to this page).
 */
app.get('/admin', (req, res) => {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = bearer || readCookie(req, 'dq_token') || (req.query.token ? String(req.query.token) : '');

  if (!token) {
    return res.redirect(302, '/admin/login?reason=missing_token');
  }

  const claims = decodeJwtPayloadUnverified(token);
  if (!claims) {
    return res.redirect(302, '/admin/login?reason=invalid_or_expired_token');
  }
  if (claims.role !== 'admin') {
    return res.redirect(302, '/admin/login?reason=not_admin');
  }

  let template;
  try {
    template = fs.readFileSync(ADMIN_TEMPLATE, 'utf8');
  } catch (err) {
    console.error('[web] admin.html missing at', ADMIN_TEMPLATE, err.message);
    return res.status(500).type('text/plain').send('Admin console template not found');
  }

  // Server-side render: substitute the placeholders in admin.html.
  const html = template
    .replace(/{{ADMIN_USERNAME}}/g, escapeHtml(claims.username || 'admin'))
    .replace(/{{API_BASE}}/g, escapeHtml(PUBLIC_API_BASE))
    .replace(/{{TOKEN}}/g, escapeHtml(token))
    .replace(/{{RENDERED_AT}}/g, escapeHtml(new Date().toISOString()))
    .replace(/{{INSTANCE_ID}}/g, escapeHtml(process.env.INSTANCE_ID || require('os').hostname()));

  res
    .status(200)
    .set('Cache-Control', 'no-store') // never cache a page containing a token
    .type('text/html')
    .send(html);
});

/** Tiny login landing page for admins bounced off /admin. */
app.get('/admin/login', (req, res) => {
  const reason = String(req.query.reason || '');
  const messages = {
    missing_token: 'You are not signed in.',
    invalid_or_expired_token: 'Your session has expired.',
    not_admin: 'That account does not have the admin role.',
  };
  res
    .status(200)
    .type('text/html')
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DigiQuiz Admin — Sign in</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;
       color:#e2e8f0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .card{background:#1e293b;padding:2rem;border-radius:14px;width:min(380px,90vw);
        box-shadow:0 20px 50px rgba(0,0,0,.4)}
  h1{margin:0 0 .25rem;font-size:1.3rem}
  p.reason{color:#fca5a5;margin:.25rem 0 1.25rem;font-size:.9rem;min-height:1.2em}
  label{display:block;font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;
        color:#94a3b8;margin:.9rem 0 .3rem}
  input{width:100%;padding:.6rem .7rem;border-radius:8px;border:1px solid #334155;
        background:#0f172a;color:#e2e8f0;box-sizing:border-box;font-size:1rem}
  button{margin-top:1.4rem;width:100%;padding:.7rem;border:0;border-radius:8px;
         background:#f59e0b;color:#0f172a;font-weight:700;font-size:1rem;cursor:pointer}
  button:hover{background:#fbbf24}
  .err{color:#fca5a5;font-size:.88rem;margin-top:.8rem;min-height:1.2em}
</style></head><body>
<form class="card" id="f">
  <h1>DigiQuiz Admin</h1>
  <p class="reason">${escapeHtml(messages[reason] || '')}</p>
  <label for="u">Username</label><input id="u" autocomplete="username" required>
  <label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
  <div class="err" id="e"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const e = document.getElementById('e'); e.textContent = '';
  try {
    const r = await fetch('${PUBLIC_API_BASE}/api/auth/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username:document.getElementById('u').value,
                            password:document.getElementById('p').value})
    });
    const d = await r.json();
    if (!r.ok) { e.textContent = d.error || 'Login failed'; return; }
    // Hand the token to the server-rendered console.
    document.cookie = 'dq_token=' + encodeURIComponent(d.token) + '; Path=/; SameSite=Strict';
    location.href = '/admin';
  } catch (err) { e.textContent = 'Network error'; }
});
</script></body></html>`);
});

// =============================================================================
// DEV ONLY — stand in for S3 + CloudFront
// =============================================================================
// Mounted LAST, after every explicit route, so it can never shadow /api/*,
// /admin or /health. It only ever answers for files that actually exist in
// public/. On AWS this block is inert because SERVE_STATIC_DIR is unset.
if (SERVE_STATIC_DIR) {
  app.use(
    express.static(path.resolve(SERVE_STATIC_DIR), {
      index: 'index.html',
      etag: true,
      maxAge: 0, // dev: always revalidate so edits show up on reload
    })
  );
  console.log(`[web-tier] DEV: serving static UI from ${path.resolve(SERVE_STATIC_DIR)}`);
  console.log('[web-tier] DEV: this stands in for S3 + CloudFront — not how AWS is built');
}

// =============================================================================
// 404 + error handler
// =============================================================================
app.use((req, res) => fail(res, 404, 'Not found'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'Malformed JSON body');
  console.error('[web] unhandled', { path: req.path, message: err && err.message });
  return fail(res, 500, 'Internal server error');
});

// =============================================================================
// Startup + graceful shutdown
// =============================================================================
// Binds 0.0.0.0, not 127.0.0.1 — this is what makes the stack reachable from a
// phone on the same WiFi. Binding to localhost would work on the computer and
// fail on every other device, which is the usual cause of "it works for me".
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[web-tier] DigiQuiz web tier listening on 0.0.0.0:${PORT}`);
  console.log(`[web-tier] forwarding /api/* to ${APP_URL}`);
});

function shutdown(signal) {
  console.log(`[web-tier] ${signal} received, draining...`);
  server.close(() => {
    console.log('[web-tier] shutdown complete');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
