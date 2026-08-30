/**
 * DigiQuiz — WP3 — app-server.js
 * =============================================================================
 * PRIVATE APPLICATION TIER.  Runs on EC2 instances in the private app subnets
 * (10.0.2.0/24 / 10.0.12.0/24) behind an internal ALB or reached directly by the
 * web tier.  Listens on port 4000.  Reachable ONLY from Web-SG.  This is the
 * ONLY tier that opens a connection to RDS.
 *
 * Design rules this file enforces
 * -----------------------------------------------------------------------------
 *  1. options.is_correct NEVER leaves this process.  The quiz-read query selects
 *     only (id, label, option_text).  The grading query reads is_correct but
 *     returns only a numeric score.
 *  2. Grading is server-side, here.  The web tier physically cannot grade because
 *     it never receives the answer key.
 *  3. Auth is stateless JWT.  No session store, so any instance in the ASG can
 *     serve any request.  On protected routes the user identity comes from the
 *     verified token (req.user.id), NEVER from the request body.
 *  4. Admin writes are re-authorised here from the token role, and executed in a
 *     transaction.  The web tier's own admin check is convenience only.
 *  5. Every query is parameterised.  No string concatenation into SQL, ever.
 *  6. No secrets in this file.  DB credentials and the JWT signing key arrive as
 *     environment variables, injected at boot from Secrets Manager (see WP5).
 * =============================================================================
 */

'use strict';

const express = require('express');
// DEV BUNDLE: the only change from the AWS build. Instead of requiring
// mysql2/promise directly, the pool comes from ./db, which returns either a real
// mysql2 pool (DB_ENGINE=mysql, Path A / AWS) or a mysql2-shaped SQLite adapter
// (DB_ENGINE=sqlite, Path B). Not one line of route logic below is aware of it.
const { createPool } = require('./db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// -----------------------------------------------------------------------------
// Configuration — all of it from the environment (WP5 injects these)
// -----------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '4000', 10);

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'digiquiz_app',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'digiquiz',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_POOL_SIZE || '10', 10),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  charset: 'utf8mb4_unicode_ci',
};

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';
const JWT_ISSUER = process.env.JWT_ISSUER || 'digiquiz';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

if (!JWT_SECRET) {
  console.error('[fatal] JWT_SECRET is not set. Refusing to start.');
  console.error('        It must be injected from Secrets Manager (see WP5 §6).');
  process.exit(1);
}
if (!DB_CONFIG.password && process.env.NODE_ENV === 'production' && process.env.DB_ENGINE !== 'sqlite') {
  console.error('[fatal] DB_PASSWORD is not set in production. Refusing to start.');
  process.exit(1);
}

const pool = createPool(DB_CONFIG);

// -----------------------------------------------------------------------------
// App + global middleware
// -----------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Minimal structured request log. Never logs the Authorization header or bodies.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        tier: 'app',
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

/** Wrap an async route so rejected promises reach the error handler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Fail a request with a clean JSON body. Never leaks internals. */
function fail(res, status, message, details) {
  const body = { error: message };
  if (details) body.details = details;
  return res.status(status).json(body);
}

/** Positive-integer route param parser. */
function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// -----------------------------------------------------------------------------
// Auth middleware
// -----------------------------------------------------------------------------

/**
 * Verifies the bearer token's SIGNATURE and expiry, and attaches the identity to
 * req.user.  This is the only place a user identity is ever established.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (!token || !/^Bearer$/i.test(scheme)) {
    return fail(res, 401, 'Missing or malformed Authorization header');
  }

  try {
    const claims = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'], // pinned: blocks the alg=none / alg-confusion attack
      issuer: JWT_ISSUER,
    });
    req.user = { id: claims.id, username: claims.username, role: claims.role };
    if (!Number.isInteger(req.user.id)) {
      return fail(res, 401, 'Invalid token payload');
    }
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return fail(res, 401, 'Token expired');
    // Signature failures, tampering, wrong issuer, wrong alg all land here.
    return fail(res, 401, 'Invalid token');
  }
}

/**
 * Re-checks the admin role from the VERIFIED token. Runs after requireAuth.
 * The web tier also checks, but that check is convenience; this one is the gate.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return fail(res, 403, 'Admin role required');
  }
  return next();
}

// =============================================================================
// ROUTES
// =============================================================================

// -----------------------------------------------------------------------------
// GET /health — for the ALB target group and the ASG health check.
// Cheap, unauthenticated, and it actually touches the database so that an
// instance which has lost RDS connectivity is taken out of service.
// -----------------------------------------------------------------------------
app.get('/health', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    try {
      await conn.query('SELECT 1');
    } finally {
      conn.release();
    }
    return res.status(200).json({ status: 'ok', tier: 'app', db: 'up' });
  } catch (err) {
    console.error('[health] db check failed:', err.code || err.message);
    return res.status(503).json({ status: 'degraded', tier: 'app', db: 'down' });
  }
});

// -----------------------------------------------------------------------------
// POST /register           (public → /api/auth/register)
// body: { username, password }         returns: { id, username }
// -----------------------------------------------------------------------------
app.post(
  '/register',
  wrap(async (req, res) => {
    const { username, password } = req.body || {};

    if (typeof username !== 'string' || typeof password !== 'string') {
      return fail(res, 400, 'username and password are required strings');
    }
    const uname = username.trim();
    if (uname.length < 3 || uname.length > 50) {
      return fail(res, 400, 'username must be 3-50 characters');
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(uname)) {
      return fail(res, 400, 'username may contain only letters, digits, _ . -');
    }
    if (password.length < 8 || password.length > 200) {
      return fail(res, 400, 'password must be 8-200 characters');
    }

    // Self-registration ALWAYS creates a student. The role is never taken from
    // the request body — that would be a privilege-escalation hole.
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    try {
      const [result] = await pool.execute(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
        [uname, passwordHash, 'student']
      );
      return res.status(201).json({ id: result.insertId, username: uname });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return fail(res, 409, 'Username already taken');
      }
      throw err;
    }
  })
);

// -----------------------------------------------------------------------------
// POST /login              (public → /api/auth/login)
// body: { username, password }         returns: { token }
// -----------------------------------------------------------------------------
app.post(
  '/login',
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return fail(res, 400, 'username and password are required strings');
    }

    const [rows] = await pool.execute(
      'SELECT id, username, password_hash, role FROM users WHERE username = ? LIMIT 1',
      [username.trim()]
    );

    // Same generic message and comparable timing for "no such user" and "wrong
    // password" so the endpoint cannot be used to enumerate usernames.
    const user = rows[0];
    const hash = user ? user.password_hash : '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) {
      return fail(res, 401, 'Invalid credentials');
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN, issuer: JWT_ISSUER }
    );

    return res.status(200).json({ token });
  })
);

// -----------------------------------------------------------------------------
// GET /quizzes             (public → /api/quizzes)
// returns: [{ id, title, description }]
// -----------------------------------------------------------------------------
app.get(
  '/quizzes',
  wrap(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT id, title, description FROM quizzes ORDER BY id ASC'
    );
    return res.status(200).json(rows);
  })
);

// -----------------------------------------------------------------------------
// GET /quizzes/:id         (auth → /api/quizzes/:id)
// returns: quiz + questions + options, WITHOUT is_correct
//
// *** THE HEADLINE SECURITY CONTROL ***
// The options query below selects exactly three columns: id, label, option_text.
// is_correct is not in the SELECT list, so it is not in the result set, so it
// cannot be in the JSON, so it cannot reach the browser. Do not "optimise" this
// into SELECT *.
// -----------------------------------------------------------------------------
app.get(
  '/quizzes/:id',
  requireAuth,
  wrap(async (req, res) => {
    const quizId = parseId(req.params.id);
    if (!quizId) return fail(res, 400, 'Invalid quiz id');

    const [quizRows] = await pool.execute(
      'SELECT id, title, description FROM quizzes WHERE id = ? LIMIT 1',
      [quizId]
    );
    if (quizRows.length === 0) return fail(res, 404, 'Quiz not found');

    const [questionRows] = await pool.execute(
      'SELECT id, stem FROM questions WHERE quiz_id = ? ORDER BY id ASC',
      [quizId]
    );

    if (questionRows.length === 0) {
      return res.status(200).json({ ...quizRows[0], questions: [] });
    }

    const questionIds = questionRows.map((q) => q.id);
    const placeholders = questionIds.map(() => '?').join(',');

    //                    v-- id, label, option_text ONLY. Never is_correct.
    const [optionRows] = await pool.execute(
      `SELECT id, question_id, label, option_text
         FROM options
        WHERE question_id IN (${placeholders})
        ORDER BY question_id ASC, label ASC`,
      questionIds
    );

    const optionsByQuestion = new Map(questionIds.map((id) => [id, []]));
    for (const o of optionRows) {
      optionsByQuestion.get(o.question_id).push({
        id: o.id,
        label: o.label,
        option_text: o.option_text,
      });
    }

    return res.status(200).json({
      ...quizRows[0],
      questions: questionRows.map((q) => ({
        id: q.id,
        stem: q.stem,
        options: optionsByQuestion.get(q.id) || [],
      })),
    });
  })
);

// -----------------------------------------------------------------------------
// POST /quizzes/:id/grade  (auth → /api/quizzes/:id/submit)
// body: { answers: [ { questionId, optionId }, ... ] }
//       (an object map { "<questionId>": <optionId> } is also accepted)
// returns: { score, total }
//
// Grading happens here and only here. The client sends the option IDs it chose;
// this tier looks up the answer key and counts. The client is never told which
// individual answers were right — only the aggregate — so the endpoint cannot be
// used as an oracle to farm the answer key one question at a time.
// -----------------------------------------------------------------------------
app.post(
  '/quizzes/:id/grade',
  requireAuth,
  wrap(async (req, res) => {
    const quizId = parseId(req.params.id);
    if (!quizId) return fail(res, 400, 'Invalid quiz id');

    // --- normalise the answers payload ------------------------------------
    let answers = (req.body || {}).answers;
    if (answers && !Array.isArray(answers) && typeof answers === 'object') {
      answers = Object.entries(answers).map(([questionId, optionId]) => ({
        questionId: Number(questionId),
        optionId: Number(optionId),
      }));
    }
    if (!Array.isArray(answers)) {
      return fail(res, 400, 'answers must be an array of { questionId, optionId }');
    }
    if (answers.length > 200) {
      return fail(res, 400, 'Too many answers');
    }

    const chosen = new Map(); // questionId -> optionId
    for (const a of answers) {
      const qid = parseId(a && a.questionId);
      const oid = parseId(a && a.optionId);
      if (!qid || !oid) {
        return fail(res, 400, 'Each answer needs a positive integer questionId and optionId');
      }
      chosen.set(qid, oid); // last write wins on duplicate questionId
    }

    // --- total = the number of questions actually in this quiz -------------
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) AS total FROM questions WHERE quiz_id = ?',
      [quizId]
    );
    if (total === 0) return fail(res, 404, 'Quiz not found or has no questions');

    // --- fetch the answer key for THIS quiz only ---------------------------
    // Joining through questions guarantees a client cannot smuggle in option IDs
    // belonging to a different quiz.
    const [keyRows] = await pool.execute(
      `SELECT o.id AS option_id, o.question_id
         FROM options   o
         JOIN questions q ON q.id = o.question_id
        WHERE q.quiz_id = ? AND o.is_correct = TRUE`,
      [quizId]
    );

    const correctOptionForQuestion = new Map(
      keyRows.map((r) => [r.question_id, r.option_id])
    );

    let score = 0;
    for (const [questionId, optionId] of chosen) {
      if (correctOptionForQuestion.get(questionId) === optionId) score += 1;
    }

    // --- record the attempt, scoped to the TOKEN's user id -----------------
    await pool.execute(
      'INSERT INTO attempts (user_id, quiz_id, score, total) VALUES (?, ?, ?, ?)',
      [req.user.id, quizId, score, total]
    );

    // Aggregate only. No per-question feedback, no answer key.
    return res.status(200).json({ score, total });
  })
);

// -----------------------------------------------------------------------------
// GET /quizzes/:id/leaderboard   (public → /api/quizzes/:id/leaderboard)
// returns: [{ username, score }] — each user's best score on that quiz
// -----------------------------------------------------------------------------
app.get(
  '/quizzes/:id/leaderboard',
  wrap(async (req, res) => {
    const quizId = parseId(req.params.id);
    if (!quizId) return fail(res, 400, 'Invalid quiz id');

    const limit = Math.min(parseInt(req.query.limit || '10', 10) || 10, 100);

    const [rows] = await pool.query(
      `SELECT u.username        AS username,
              MAX(a.score)      AS score
         FROM attempts a
         JOIN users    u ON u.id = a.user_id
        WHERE a.quiz_id = ?
        GROUP BY u.id, u.username
        ORDER BY score DESC, MIN(a.taken_at) ASC
        LIMIT ?`,
      [quizId, limit]
    );

    return res.status(200).json(rows.map((r) => ({ username: r.username, score: r.score })));
  })
);

// -----------------------------------------------------------------------------
// GET /attempts            (auth → /api/me/attempts)
// returns: [{ quizTitle, score, total, takenAt }]
//
// Scoped by req.user.id, which comes from the verified token. There is no user id
// parameter on this route at all, so user A has no mechanism to request user B's
// history (the WP8 IDOR test).
// -----------------------------------------------------------------------------
app.get(
  '/attempts',
  requireAuth,
  wrap(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT q.title    AS quizTitle,
              a.score    AS score,
              a.total    AS total,
              a.taken_at AS takenAt
         FROM attempts a
         JOIN quizzes  q ON q.id = a.quiz_id
        WHERE a.user_id = ?
        ORDER BY a.taken_at DESC, a.id DESC
        LIMIT 100`,
      [req.user.id]
    );
    return res.status(200).json(rows);
  })
);

// -----------------------------------------------------------------------------
// POST /admin/quizzes      (admin → /api/admin/quizzes)
// body: {
//   title, description,
//   questions: [ { stem, options: [ { label, text, isCorrect } x4 ] } ]
// }
// returns: { id }
//
// Runs in a transaction: a half-created quiz (questions with no options, or a
// question with no correct answer) would silently corrupt grading, so either the
// whole quiz lands or none of it does.
// -----------------------------------------------------------------------------
app.post(
  '/admin/quizzes',
  requireAuth,
  requireAdmin, // <- re-checked here from the verified token, not trusted from the web tier
  wrap(async (req, res) => {
    const { title, description, questions } = req.body || {};

    // ---- validate the whole payload BEFORE opening a transaction ----------
    if (typeof title !== 'string' || title.trim().length === 0 || title.length > 150) {
      return fail(res, 400, 'title is required and must be 1-150 characters');
    }
    if (description != null && (typeof description !== 'string' || description.length > 500)) {
      return fail(res, 400, 'description must be a string of at most 500 characters');
    }
    if (!Array.isArray(questions) || questions.length === 0 || questions.length > 100) {
      return fail(res, 400, 'questions must be a non-empty array of at most 100 items');
    }

    for (const [i, q] of questions.entries()) {
      if (!q || typeof q.stem !== 'string' || q.stem.trim().length === 0 || q.stem.length > 500) {
        return fail(res, 400, `questions[${i}].stem is required and must be 1-500 characters`);
      }
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
        return fail(res, 400, `questions[${i}].options must contain 2-4 options`);
      }
      let correctCount = 0;
      const seenLabels = new Set();
      for (const [j, o] of q.options.entries()) {
        const text = o && (o.text != null ? o.text : o.option_text);
        if (typeof text !== 'string' || text.trim().length === 0 || text.length > 300) {
          return fail(res, 400, `questions[${i}].options[${j}].text is required and must be 1-300 characters`);
        }
        const label = String((o && o.label) || 'ABCD'[j]).toUpperCase();
        if (!/^[A-D]$/.test(label)) {
          return fail(res, 400, `questions[${i}].options[${j}].label must be A, B, C or D`);
        }
        if (seenLabels.has(label)) {
          return fail(res, 400, `questions[${i}] has duplicate option label ${label}`);
        }
        seenLabels.add(label);
        if (o.isCorrect === true || o.is_correct === true) correctCount += 1;
      }
      if (correctCount !== 1) {
        return fail(res, 400, `questions[${i}] must have exactly one correct option (found ${correctCount})`);
      }
    }

    // ---- write it, all or nothing ----------------------------------------
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [quizResult] = await conn.execute(
        'INSERT INTO quizzes (title, description) VALUES (?, ?)',
        [title.trim(), description ? description.trim() : null]
      );
      const quizId = quizResult.insertId;

      for (const q of questions) {
        const [qResult] = await conn.execute(
          'INSERT INTO questions (quiz_id, stem) VALUES (?, ?)',
          [quizId, q.stem.trim()]
        );
        const questionId = qResult.insertId;

        for (const [j, o] of q.options.entries()) {
          const text = (o.text != null ? o.text : o.option_text).trim();
          const label = String(o.label || 'ABCD'[j]).toUpperCase();
          const isCorrect = o.isCorrect === true || o.is_correct === true;
          await conn.execute(
            'INSERT INTO options (question_id, label, option_text, is_correct) VALUES (?, ?, ?, ?)',
            [questionId, label, text, isCorrect]
          );
        }
      }

      await conn.commit();
      console.log(
        JSON.stringify({
          t: new Date().toISOString(),
          tier: 'app',
          event: 'quiz_created',
          quizId,
          by: req.user.username,
          questions: questions.length,
        })
      );
      return res.status(201).json({ id: quizId });
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  })
);

// -----------------------------------------------------------------------------
// 404 + central error handler
// -----------------------------------------------------------------------------
app.use((req, res) => fail(res, 404, 'Not found'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return fail(res, 400, 'Malformed JSON body');
  }

  // Log the detail server-side; return something generic to the caller.
  console.error('[error]', {
    path: req.path,
    code: err && err.code,
    message: err && err.message,
  });

  if (err && (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ETIMEDOUT')) {
    return fail(res, 503, 'Database unavailable');
  }
  return fail(res, 500, 'Internal server error');
});

// -----------------------------------------------------------------------------
// Startup + graceful shutdown (so the ALB can drain cleanly on scale-in)
// -----------------------------------------------------------------------------
// Binds 0.0.0.0, not 127.0.0.1, so the web tier can reach it from another
// container (Path A) and so the stack is reachable from a phone on the LAN.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[app-tier] DigiQuiz application tier listening on 0.0.0.0:${PORT}`);
  if ((process.env.DB_ENGINE || 'mysql').toLowerCase() === 'sqlite') {
    console.log('[app-tier] db sqlite (dev only — the AWS build uses RDS MySQL Multi-AZ)');
  } else {
    console.log(`[app-tier] db ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  }
});

function shutdown(signal) {
  console.log(`[app-tier] ${signal} received, draining...`);
  server.close(async () => {
    await pool.end().catch(() => {});
    console.log('[app-tier] shutdown complete');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
