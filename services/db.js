// sql.js database — lazy-initialized proxy that mimics better-sqlite3 API
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'project-checker.db');

let db = null;
let SQL = null;
const pending = []; // queued operations until db is ready

const now = () => new Date().toISOString();

function flushPending() {
  while (pending.length) {
    const { fn } = pending.shift();
    fn();
  }
}

function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, bufferFrom(data));
}

function bufferFrom(data) {
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

// Thin wrapper mimicking better-sqlite3's Statement
class Stmt {
  constructor(sql) {
    this.sql = sql.trim();
    this._isSelect = /^SELECT/i.test(this.sql);
  }

  _run(params) {
    const p = Array.isArray(params) ? params : [params];
    db.run(this.sql, p);
    const r = db.exec('SELECT last_insert_rowid()');
    const lastId = r[0]?.values[0]?.[0] ?? 0;
    save();
    return { lastInsertRowid: lastId };
  }

  _upsert(sql, params) {
    // Parse INSERT ... ON CONFLICT ... DO UPDATE SET
    const m = sql.match(
      /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)(.*)$/is
    );
    if (!m) throw new Error('UPSERT parse error: ' + sql);
    const [, table, colsStr,, conflict] = m;
    const cols = colsStr.split(',').map(c => c.trim());

    // Conflict target cols
    const onMatch = conflict.match(/ON CONFLICT\s*\(([^)]+)\)/i);
    if (!onMatch) { db.run(sql, params); save(); return { lastInsertRowid: 0 }; }
    const onCols = onMatch[1].split(',').map(c => c.trim());

    // Build WHERE clause
    const whereClause = onCols.map(c => `${c} = ?`).join(' AND ');
    const whereParams = onCols.map(c => {
      const idx = cols.indexOf(c);
      return idx >= 0 ? params[idx] : null;
    });

    // Check existence
    const existing = db.exec(`SELECT 1 FROM ${table} WHERE ${whereClause}`, whereParams);
    const doUpdate = conflict.match(/DO UPDATE SET (.+)/i)?.[1] || '';

    if (existing.length && existing[0].values.length > 0) {
      // UPDATE
      const pairs = doUpdate.split(',').map(s => {
        const [k] = s.trim().split('=').map(x => x.trim());
        return `${k} = ?`;
      }).filter(Boolean);
      if (pairs.length) {
        const setParams = cols.map(c => {
          const re = new RegExp(`\\b${c}\\s*=\\s*\\?`, 'i');
          return doUpdate.match(re) ? params[cols.indexOf(c)] : null;
        }).filter(v => v !== null);
        db.run(`UPDATE ${table} SET ${pairs.join(', ')} WHERE ${whereClause}`, [...setParams, ...whereParams]);
      }
    } else {
      // INSERT
      const allCols = colsStr.split(',').map(c => c.trim());
      const allVals = allCols.map((_, i) => params[i] ?? null);
      db.run(`INSERT INTO ${table} (${colsStr}) VALUES (${allVals.map(() => '?').join(', ')})`, allVals);
    }
    save();
    const r = db.exec('SELECT last_insert_rowid()');
    return { lastInsertRowid: r[0]?.values[0]?.[0] ?? 0 };
  }

  run(...params) {
    if (!db) { pending.push({ fn: () => this.run(...params) }); return { lastInsertRowid: 0 }; }
    try {
      if (/ON CONFLICT/i.test(this.sql)) return this._upsert(this.sql, params);
      return this._run(params);
    } catch (err) {
      if (err.message.includes('ON CONFLICT') || err.message.includes('UPSERT')) {
        return this._upsert(this.sql, params);
      }
      throw err;
    }
  }

  all(...params) {
    if (!db) return [];
    try {
      const result = db.exec(this.sql, Array.isArray(params) ? params : [params]);
      if (!result.length) return [];
      const cols = result[0].columns;
      return result[0].values.map(row => {
        const obj = {};
        cols.forEach((c, i) => obj[c] = row[i]);
        return obj;
      });
    } catch (err) {
      if (err.message.includes('ON CONFLICT') || err.message.includes('UPSERT')) {
        db.run(this.sql, params);
        save();
        return [];
      }
      throw err;
    }
  }

  get(...params) {
    return this.all(...params)[0] ?? undefined;
  }
}

// Proxy: intercepts db.prepare() while also allowing direct calls
const dbProxy = new Proxy({}, {
  get(_, prop) {
    if (prop === 'then') return undefined; // prevent "promise then" issues
    if (prop === 'init') return init;
    if (prop === 'prepare') return (sql) => new Stmt(sql);
    if (prop === 'exec') {
      return (sql, params = []) => {
        if (!db) { pending.push({ fn: () => dbProxy.exec(sql, params) }); return; }
        db.run(sql, Array.isArray(params) ? params : [params]);
        save();
      };
    }
    if (prop === 'run') {
      return (sql, ...params) => {
        if (!db) { pending.push({ fn: () => dbProxy.run(sql, ...params) }); return { lastInsertRowid: 0 }; }
        const p = Array.isArray(params) ? params : [params];
        db.run(sql, p);
        const r = db.exec('SELECT last_insert_rowid()');
        const lastId = r[0]?.values[0]?.[0] ?? 0;
        save();
        return { lastInsertRowid: lastId };
      };
    }
    return undefined;
  }
});

module.exports = dbProxy;

async function init() {
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log(`[${now()}] Database loaded from ${DB_PATH}`);
  } else {
    db = new SQL.Database();
    console.log(`[${now()}] New database created at ${DB_PATH}`);
  }

  db.run('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      website_url TEXT,
      github_url TEXT,
      twitter_url TEXT,
      telegram_url TEXT,
      website_enabled INTEGER NOT NULL DEFAULT 1,
      github_enabled INTEGER NOT NULL DEFAULT 1,
      twitter_enabled INTEGER NOT NULL DEFAULT 1,
      telegram_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      repo_name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      repo_url TEXT,
      description TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      first_commit_date TEXT,
      latest_commit_date TEXT,
      total_commits INTEGER NOT NULL DEFAULT 0,
      latest_commit_sha TEXT,
      latest_commit_message TEXT,
      pushed_at TEXT,
      stars_count INTEGER NOT NULL DEFAULT 0,
      language TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      UNIQUE (project_id, full_name)
    );
  `);

  // Rename old table if it exists (ignore error if already renamed)
  try { db.exec(`ALTER TABLE check_configs RENAME TO config`); } catch (_) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      commit_check_minutes INTEGER NOT NULL DEFAULT 360,
      website_check_minutes INTEGER NOT NULL DEFAULT 1440,
      twitter_check_minutes INTEGER NOT NULL DEFAULT 1440,
      github_token TEXT,
      log_retention_days INTEGER NOT NULL DEFAULT 7,
      ui_refresh_seconds INTEGER NOT NULL DEFAULT 60
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS check_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('website', 'github', 'twitter')),
      resource_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'disabled', 'unavailable')),
      http_status INTEGER,
      response_time_ms INTEGER,
      error_message TEXT,
      details TEXT,
      checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_check_logs_project_resource_date
    ON check_logs (project_id, resource_type, checked_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_status_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('website', 'github', 'twitter')),
      event_type TEXT NOT NULL CHECK (event_type IN ('confirmed', 'changed')),
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rsc_project_resource
    ON resource_status_changes (project_id, resource_type, created_at DESC);
  `);

  // Run migrations (idempotent — handles schema changes from older DB files)
  const { runMigrations } = require('./migrations');
  runMigrations(db, save);

  const existing = db.exec('SELECT id FROM config WHERE id = 1');
  if (!existing.length || !existing[0].values.length) {
    db.run('INSERT INTO config (id, commit_check_minutes, website_check_minutes, twitter_check_minutes, log_retention_days, ui_refresh_seconds) VALUES (1, 360, 1440, 1440, 7, 60)');
    save();
  }

  console.log(`[${now()}] Database initialized`);
  flushPending();
  return dbProxy;
}

module.exports.init = init;
