/**
 * DigiQuiz dev bundle — tools/dev.js   (Path B supervisor)
 * =============================================================================
 * Starts BOTH tiers as separate processes against SQLite, waits for each to be
 * healthy, then prints the phone banner.
 *
 *   npm run dev
 *
 * They are separate OS processes on purpose. The whole point of the project is
 * that the web tier and the app tier are different machines with different
 * privileges; collapsing them into one process for convenience would quietly
 * delete the property the project is meant to demonstrate.
 *
 * Cross-platform: uses process.execPath and shell:false, so it behaves the same
 * in PowerShell, cmd.exe, Terminal.app and bash. No dependencies.
 * =============================================================================
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 4000);
const WEB_PORT = Number(process.env.WEB_PORT || 8080);

// -----------------------------------------------------------------------------
// Preflight
// -----------------------------------------------------------------------------
function nodeVersionParts() {
  return process.versions.node.split('.').map(Number);
}

function checkSqliteAvailable() {
  try {
    require('node:sqlite');
    return { ok: true, driver: 'node:sqlite (built into Node — nothing to install)' };
  } catch (_) {
    try {
      require.resolve('better-sqlite3', { paths: [ROOT] });
      return { ok: true, driver: 'better-sqlite3 (native module)' };
    } catch (__) {
      const [maj, min] = nodeVersionParts();
      return {
        ok: false,
        message:
          `Node ${process.versions.node} has no usable SQLite.\n` +
          `  node:sqlite needs Node 22.5.0 or newer` +
          (maj < 22 || (maj === 22 && min < 5) ? ' — please upgrade Node.' : '.') +
          '\n  Alternatives:\n' +
          '    * upgrade Node   -> https://nodejs.org  (LTS is fine)\n' +
          '    * npm install better-sqlite3   (needs a C++ build toolchain)\n' +
          '    * use Path A instead: docker compose up',
      };
    }
  }
}

function checkDependencies() {
  const missing = [];
  for (const dep of ['express', 'bcryptjs', 'jsonwebtoken']) {
    try { require.resolve(dep, { paths: [ROOT] }); } catch { missing.push(dep); }
  }
  return missing;
}

/** Minimal .env reader — avoids a dotenv dependency for five lines of config. */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Child process management
// -----------------------------------------------------------------------------
const children = [];
let shuttingDown = false;

function start(label, colour, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  children.push(child);

  const tag = process.stdout.isTTY ? `\x1b[${colour}m[${label}]\x1b[0m` : `[${label}]`;
  const pipe = (stream, isError) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach((l) => {
        if (!l.trim()) return;
        // node:sqlite prints an ExperimentalWarning on every boot; it is
        // expected and says nothing useful to the user.
        if (/ExperimentalWarning: SQLite/.test(l)) return;
        if (/Use `node --trace-warnings/.test(l)) return;
        (isError ? process.stderr : process.stdout).write(`${tag} ${l}\n`);
      });
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${label} exited unexpectedly (code=${code} signal=${signal}).`);
    shutdown(1);
  });

  return child;
}

async function waitForHealth(url, label, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`[dev] ${label} did not become healthy at ${url}`);
  return false;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[dev] stopping...');
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(code), 600).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
(async function main() {
  console.log('DigiQuiz dev stack (Path B — SQLite, no Docker, no MySQL)\n');

  const [maj, min] = nodeVersionParts();
  if (maj < 18) {
    console.error(`Node ${process.versions.node} is too old. This bundle needs Node 18+ ` +
                  '(and Node 22.5+ for the zero-install SQLite path).');
    process.exit(1);
  }

  const missing = checkDependencies();
  if (missing.length) {
    console.error(`Missing dependencies: ${missing.join(', ')}`);
    console.error('Run:  npm install');
    process.exit(1);
  }

  const sqlite = checkSqliteAvailable();
  if (!sqlite.ok) { console.error(sqlite.message); process.exit(1); }
  console.log(`[dev] sqlite driver: ${sqlite.driver}`);

  if (loadDotEnv()) console.log('[dev] loaded .env');

  // Dev-only: if no JWT secret was supplied, invent one for this run. On AWS
  // this comes from Secrets Manager and is shared across every app instance.
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64');
    console.log('[dev] generated a throwaway JWT_SECRET for this run ' +
                '(set one in .env to keep sessions across restarts)');
  }

  start('app', '36', path.join(ROOT, 'app-tier', 'app-server.js'), {
    PORT: String(APP_PORT),
    DB_ENGINE: 'sqlite',
    SQLITE_FILE: process.env.SQLITE_FILE || path.join(ROOT, 'data', 'digiquiz.sqlite'),
    SQLITE_SEED: process.env.SQLITE_SEED || path.join(ROOT, 'sql', 'digiquiz.sqlite.sql'),
    NODE_ENV: 'development',
  });

  if (!(await waitForHealth(`http://127.0.0.1:${APP_PORT}/health`, 'app tier'))) shutdown(1);

  start('web', '33', path.join(ROOT, 'web-tier', 'web-server.js'), {
    PORT: String(WEB_PORT),
    APP_URL: `http://127.0.0.1:${APP_PORT}`,
    PUBLIC_API_BASE: '',
    SERVE_STATIC_DIR: path.join(ROOT, 'web-tier', 'public'),
    ALLOWED_ORIGIN: '*',
    NODE_ENV: 'development',
  });

  if (!(await waitForHealth(`http://127.0.0.1:${WEB_PORT}/health`, 'web tier'))) shutdown(1);

  // eslint-disable-next-line global-require
  require('./banner').printBanner({ port: WEB_PORT, qr: process.env.NO_QR !== '1' });
})();
