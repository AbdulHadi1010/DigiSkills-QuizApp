/**
 * DigiQuiz dev bundle — app-tier/db.js
 * =============================================================================
 * A thin database adapter so that ONE copy of app-server.js runs unchanged
 * against either engine:
 *
 *   DB_ENGINE=mysql   -> a real mysql2/promise pool (Path A / AWS RDS)
 *   DB_ENGINE=sqlite  -> node:sqlite (or better-sqlite3) wearing a mysql2-shaped
 *                        mask (Path B — dev only, no MySQL install needed)
 *
 * WHY AN ADAPTER AND NOT A SECOND SERVER FILE
 * -----------------------------------------------------------------------------
 * The route logic in app-server.js is the thing under test: the quiz-read query
 * that omits is_correct, the server-side grader, the token-scoped attempts
 * lookup, the transactional admin write. Forking it for dev would mean the code
 * you demo is not the code you deploy, and the security properties would have to
 * be re-proved in two places. So the fork happens HERE, one layer below the SQL,
 * and app-server.js cannot tell the difference.
 *
 * The surface this module must emulate, because that is all app-server.js uses:
 *
 *   pool.execute(sql, params)  -> [rows, meta]      meta.insertId, meta.affectedRows
 *   pool.query(sql, params)    -> [rows, meta]      (used where LIMIT ? is bound)
 *   pool.getConnection()       -> conn
 *   conn.beginTransaction() / conn.commit() / conn.rollback()
 *   conn.execute(sql, params) / conn.query(sql, params)
 *   conn.release()
 *   pool.end()
 *
 * plus one error contract: a duplicate username must surface as
 * `err.code === 'ER_DUP_ENTRY'`, which is what app-server.js turns into a 409.
 *
 * *** DEV-ONLY, DIFFERS FROM THE AWS BUILD ***
 * On AWS the app tier talks to RDS MySQL Multi-AZ through mysql2 with a real
 * connection pool. The SQLite branch below is a local convenience only. See the
 * "Dev vs AWS" table in DEV-README.md.
 * =============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// MySQL branch — the production path. mysql2 is required lazily so that Path B
// works without it installed at all.
// -----------------------------------------------------------------------------
function createMysqlPool(config) {
  // eslint-disable-next-line global-require
  const mysql = require('mysql2/promise');
  console.log(`[db] engine=mysql  ${config.user}@${config.host}:${config.port}/${config.database}`);
  return mysql.createPool(config);
}

// -----------------------------------------------------------------------------
// SQLite branch
// -----------------------------------------------------------------------------

/** Load a SQLite driver, preferring the one built into Node 22.5+. */
function loadSqliteDriver() {
  try {
    // Node's own, zero install. Emits an ExperimentalWarning we silence below.
    // eslint-disable-next-line global-require
    const { DatabaseSync } = require('node:sqlite');
    return {
      name: 'node:sqlite',
      open: (file) => {
        const db = new DatabaseSync(file);
        return {
          exec: (sql) => db.exec(sql),
          prepare: (sql) => {
            const st = db.prepare(sql);
            return {
              all: (...p) => st.all(...p),
              run: (...p) => {
                const r = st.run(...p);
                return {
                  changes: Number(r.changes),
                  lastInsertRowid: Number(r.lastInsertRowid),
                };
              },
            };
          },
          close: () => db.close(),
        };
      },
    };
  } catch (nodeSqliteErr) {
    try {
      // eslint-disable-next-line global-require
      const Database = require('better-sqlite3');
      return {
        name: 'better-sqlite3',
        open: (file) => {
          const db = new Database(file);
          return {
            exec: (sql) => db.exec(sql),
            prepare: (sql) => {
              const st = db.prepare(sql);
              return {
                all: (...p) => st.all(...p),
                run: (...p) => {
                  const r = st.run(...p);
                  return {
                    changes: Number(r.changes),
                    lastInsertRowid: Number(r.lastInsertRowid),
                  };
                },
              };
            },
            close: () => db.close(),
          };
        },
      };
    } catch (betterSqliteErr) {
      const e = new Error(
        'No SQLite driver available.\n' +
        '  node:sqlite needs Node 22.5 or newer (you have ' + process.version + ').\n' +
        '  Either upgrade Node, or run:  npm install better-sqlite3\n' +
        '  Or use Path A (Docker), which uses real MySQL.\n' +
        '  node:sqlite said:      ' + nodeSqliteErr.message + '\n' +
        '  better-sqlite3 said:   ' + betterSqliteErr.message
      );
      e.code = 'NO_SQLITE_DRIVER';
      throw e;
    }
  }
}

/** First non-comment word of a statement, uppercased. */
function statementVerb(sql) {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  const m = stripped.match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : '';
}

/**
 * Translate the small set of MySQL-isms app-server.js emits into SQLite.
 *
 * app-server.js is written in portable SQL on purpose, so this is deliberately
 * tiny — if this function ever needs to grow, that is a signal the route logic
 * has drifted towards one engine and should be corrected there instead.
 */
function toSqlite(sql) {
  return sql
    .replace(/\bTRUE\b/g, '1')
    .replace(/\bFALSE\b/g, '0');
}

/**
 * Coerce bind parameters into the narrow set of types SQLite accepts.
 *
 * mysql2 happily binds a JavaScript boolean, a Date, or undefined. node:sqlite
 * accepts only null, number, bigint, string and Uint8Array, and throws
 * TypeError on anything else. app-server.js legitimately binds booleans — the
 * admin create-quiz path passes `isCorrect` straight through to
 * `INSERT INTO options (..., is_correct) VALUES (?, ?, ?, ?)`.
 *
 * Translating here rather than in the route keeps the SQL portable and keeps
 * the route logic identical between engines. (Found by tools/verify-dev.js:
 * without this, admin quiz creation returned 500 on Path B while working
 * perfectly on Path A.)
 */
function bindable(params) {
  return (params || []).map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p === undefined) return null;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

/** Map a SQLite error onto the mysql2 error code app-server.js checks for. */
function mapError(err, sql) {
  const msg = String(err && err.message);
  if (/UNIQUE constraint failed/i.test(msg)) {
    const e = new Error(msg);
    e.code = 'ER_DUP_ENTRY';
    e.sqliteMessage = msg;
    return e;
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    const e = new Error(msg);
    e.code = 'ER_NO_REFERENCED_ROW_2';
    return e;
  }
  err.sql = sql;
  return err;
}

function createSqlitePool(config) {
  const driver = loadSqliteDriver();
  const file = config.sqliteFile;
  const seedFile = config.sqliteSeed;

  const fresh = !fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = driver.open(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');   // survives two tiers reading at once
  db.exec('PRAGMA busy_timeout = 5000;');

  // Auto-seed on first run (or if the schema is missing from an existing file).
  let needsSeed = fresh;
  if (!needsSeed) {
    try {
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all();
      const rows = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='users'").all();
      needsSeed = !rows.length || rows[0].n === 0;
    } catch {
      needsSeed = true;
    }
  }
  if (needsSeed) {
    if (!fs.existsSync(seedFile)) {
      throw new Error(`[db] seed file not found: ${seedFile}`);
    }
    db.exec(fs.readFileSync(seedFile, 'utf8'));
    console.log(`[db] seeded ${path.basename(file)} from ${path.basename(seedFile)}`);
  }

  console.log(`[db] engine=sqlite driver=${driver.name} file=${file}`);

  /** Run one statement and return a mysql2-shaped [rows, meta] tuple. */
  function run(sql, params = []) {
    const translated = toSqlite(sql);
    const bound = bindable(params);
    const verb = statementVerb(translated);
    try {
      const stmt = db.prepare(translated);
      if (verb === 'SELECT' || verb === 'PRAGMA' || verb === 'WITH') {
        const rows = stmt.all(...bound);
        return [rows, undefined];
      }
      const info = stmt.run(...bound);
      return [
        { insertId: info.lastInsertRowid, affectedRows: info.changes },
        undefined,
      ];
    } catch (err) {
      throw mapError(err, translated);
    }
  }

  // One process, one file handle. Node is single-threaded and every call site in
  // app-server.js awaits in sequence, so a single implicit connection is safe for
  // dev. Real MySQL gets a real pool.
  let inTransaction = false;

  const connection = {
    execute: async (sql, params) => run(sql, params),
    query: async (sql, params) => run(sql, params),
    beginTransaction: async () => {
      if (inTransaction) throw new Error('[db] nested transaction (not supported in the dev adapter)');
      db.exec('BEGIN');
      inTransaction = true;
    },
    commit: async () => {
      if (!inTransaction) return;
      db.exec('COMMIT');
      inTransaction = false;
    },
    rollback: async () => {
      if (!inTransaction) return;
      db.exec('ROLLBACK');
      inTransaction = false;
    },
    release: () => {},
  };

  return {
    execute: async (sql, params) => run(sql, params),
    query: async (sql, params) => run(sql, params),
    getConnection: async () => connection,
    end: async () => {
      try { if (inTransaction) db.exec('ROLLBACK'); } catch { /* ignore */ }
      db.close();
    },
    _engine: 'sqlite',
    _driver: driver.name,
  };
}

// -----------------------------------------------------------------------------
// Public factory
// -----------------------------------------------------------------------------
function createPool(config) {
  const engine = (process.env.DB_ENGINE || 'mysql').toLowerCase();

  if (engine === 'sqlite') {
    return createSqlitePool({
      sqliteFile: process.env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'digiquiz.sqlite'),
      sqliteSeed: process.env.SQLITE_SEED || path.join(__dirname, '..', 'sql', 'digiquiz.sqlite.sql'),
    });
  }

  if (engine === 'mysql' || engine === 'mariadb') {
    return createMysqlPool(config);
  }

  throw new Error(`[db] unknown DB_ENGINE "${engine}" — expected "mysql" or "sqlite"`);
}

module.exports = { createPool };
