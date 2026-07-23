// node:sqlite — built-in file-based SQLite (Node.js 22.5+)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'project-checker.db');

let db = null;

/** Returns the current ISO timestamp. */
const now = () => new Date().toISOString();

// Open (or create) the DB file.
function openDatabase() {
  // ponytail: DatabaseSync constructor auto-opens the file and persists changes
  db = new DatabaseSync(DB_PATH, { enableForeignKeyConstraints: true });
  console.log(`[${now()}] Database opened: ${DB_PATH}`);
  return db;
}

/** Initializes the database: creates tables, runs migrations, and seeds config. */
async function init() {
  const database = openDatabase();

  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      website TEXT,
      github TEXT,
      twitter TEXT,
      telegram TEXT,
      token TEXT,
      website_enabled INTEGER NOT NULL DEFAULT 1,
      github_enabled INTEGER NOT NULL DEFAULT 1,
      twitter_enabled INTEGER NOT NULL DEFAULT 1,
      telegram_enabled INTEGER NOT NULL DEFAULT 1,
      token_enabled INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      activity_display INTEGER NOT NULL DEFAULT 1,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects (user_id);
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_config_user_id ON config (user_id);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
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
      status TEXT NOT NULL DEFAULT 'active',
      latest_tag TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      UNIQUE (project_id, full_name)
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS twitter_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      post_id TEXT NOT NULL,
      author TEXT,
      link TEXT,
      content TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      UNIQUE (project_id, post_id)
    );
  `);

  // Rename old table if it exists
  const checkConfigRow = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='check_configs'").get();
  if (checkConfigRow) {
    database.exec(`ALTER TABLE check_configs RENAME TO config`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      user_id TEXT NOT NULL DEFAULT '',
      settings TEXT NOT NULL DEFAULT '{"log_retention_days":7,"event_log_retention_days":14,"alert_log_retention_days":14,"twitter_posts_per_project":50,"ui_refresh_seconds":60,"compact_activity_display":0,"github_token":null,"api_token":null,"logs_per_page":20,"checks_on_new_project":1}',
      check_intervals TEXT NOT NULL DEFAULT '{"github":360,"website":1440,"twitter":1440}',
      alert_intervals TEXT NOT NULL DEFAULT '{"github":60,"website":60,"twitter":60}',
      alert_stops TEXT NOT NULL DEFAULT '{"github":1440,"website":1440,"twitter":1440}',
      telegram TEXT NOT NULL DEFAULT '{"bot_token":"","chat_id":"","enabled":false}',
      pushbullet TEXT NOT NULL DEFAULT '{"access_token":"","enabled":false}',
      price_alerts TEXT NOT NULL DEFAULT '{"alerts":[{"price_for":"6h","price_change":10,"price_interval":5,"enabled":1,"telegram":1,"pushbullet":1,"log":1},{"price_for":"6h","price_change":25,"price_interval":15,"enabled":1,"telegram":1,"pushbullet":1,"log":1},{"price_for":"6h","price_change":50,"price_interval":60,"enabled":1,"telegram":1,"pushbullet":1,"log":1}]}',
      webshare TEXT NOT NULL DEFAULT '{"enabled":false,"token":null,"country":""}'
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS check_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('website', 'github', 'twitter', 'price')),
      resource_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'disabled', 'unavailable', 'deleted', 'changed')),
      http_status INTEGER,
      response_time_ms INTEGER,
      error_message TEXT,
      details TEXT,
      checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_check_logs_project_resource_date
    ON check_logs (project_id, resource_type, checked_at);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('website', 'github', 'twitter', 'price')),
      event_type TEXT NOT NULL CHECK (event_type IN ('changed', 'deleted', 'tag_changed')),
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      confirmed INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_logs_project_resource
    ON event_logs (project_id, resource_type, created_at DESC);
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_logs_alerting
    ON event_logs (resource_type, confirmed, created_at DESC);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS alert_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status_change_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (status_change_id) REFERENCES event_logs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_alert_logs_status_change_id ON alert_logs(status_change_id);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS token_prices (
      project_id INTEGER PRIMARY KEY,
      symbol TEXT,
      chain TEXT,
      contract TEXT,
      price_usd REAL,
      price_change_h1 REAL,
      price_change_h6 REAL,
      price_change_h24 REAL,
      liquidity_usd REAL,
      volume_h24 REAL,
      market_cap REAL,
      pair_created_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS proxy_stats (
      host TEXT PRIMARY KEY,
      successes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      total_response_ms INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      last_success_at TEXT,
      last_fail_at TEXT
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS token_prices_alerts (
      project_id INTEGER NOT NULL,
      price_change REAL NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, price_change)
    );
  `);

  // Run migrations
  const { runMigrations } = require('./migrations');
  await runMigrations(database);

  console.log(`[${now()}] Database initialized`);
  return dbProxy;
}

// ponytail: coerce types SQLite can't bind — booleans → 0/1, objects/arrays → JSON
function bindParams(params) {
  return params.map(v => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object' && v !== null) return JSON.stringify(v);
    return v;
  });
}

// Promisified prepare — all methods return promises
/** Promise-based proxy exposing prepare/exec for the underlying DatabaseSync handle. */
const dbProxy = {
  /** Prepares a SQL statement and returns promise-based run/get/all methods. */
  prepare(sql) {
    return {
      run(...params) {
        db.prepare(sql).run(...bindParams(params));
        const row = db.prepare('SELECT last_insert_rowid() as id').get();
        return Promise.resolve({ lastInsertRowid: row.id });
      },
      get(...params) {
        const row = db.prepare(sql).get(...bindParams(params));
        return Promise.resolve(row ?? undefined);
      },
      all(...params) {
        const rows = db.prepare(sql).all(...bindParams(params));
        return Promise.resolve(rows);
      }
    };
  },
  /** Executes raw SQL or a prepared statement with optional params. */
  exec(sql, params = []) {
    if (params.length) {
      db.prepare(sql).run(...params);
    } else {
      db.exec(sql);
    }
    return Promise.resolve();
  },
  /** Ensures a config row exists for the given userId, creating with defaults if missing. */
  async ensureConfig(userId = '') {
    const row = await dbProxy.prepare('SELECT id FROM config WHERE user_id = ?').get(userId);
    if (row) return;
    await dbProxy.prepare(`
      INSERT INTO config (user_id, settings, check_intervals, alert_intervals, alert_stops, telegram, pushbullet, price_alerts)
      VALUES (?, '{"log_retention_days":7,"event_log_retention_days":14,"alert_log_retention_days":14,"twitter_posts_per_project":50,"ui_refresh_seconds":60,"compact_activity_display":0,"github_token":null,"api_token":null,"logs_per_page":20,"checks_on_new_project":1}',
              '{"github":360,"website":1440,"twitter":1440}',
              '{"github":60,"website":60,"twitter":60}',
              '{"github":1440,"website":1440,"twitter":1440}',
              '{"bot_token":"","chat_id":"","enabled":false}',
              '{"access_token":"","enabled":false}',
              '{"alerts":[{"price_for":"6h","price_change":10,"price_interval":5,"enabled":1,"telegram":1,"pushbullet":1,"log":1},{"price_for":"6h","price_change":25,"price_interval":15,"enabled":1,"telegram":1,"pushbullet":1,"log":1},{"price_for":"6h","price_change":50,"price_interval":60,"enabled":1,"telegram":1,"pushbullet":1,"log":1}]}')
    `).run(userId);
  },

  /** Config readers — parse JSON group columns from the singleton config row.
   *  Defaults to DEFAULT_USER_ID env var so the scheduler (no user context) can read config. */
  config: {
    async getSettings(userId = process.env.DEFAULT_USER_ID || '') {
      const row = await dbProxy.prepare('SELECT settings FROM config WHERE user_id = ?').get(userId);
      return row ? JSON.parse(row.settings) : null;
    },
    async getCheckIntervals(userId = process.env.DEFAULT_USER_ID || '') {
      const row = await dbProxy.prepare('SELECT check_intervals FROM config WHERE user_id = ?').get(userId);
      return row ? JSON.parse(row.check_intervals) : null;
    },
    async getAlertIntervals(userId = process.env.DEFAULT_USER_ID || '') {
      const row = await dbProxy.prepare('SELECT alert_intervals FROM config WHERE user_id = ?').get(userId);
      return row ? JSON.parse(row.alert_intervals) : null;
    },
    async getAlertStops(userId = process.env.DEFAULT_USER_ID || '') {
      const row = await dbProxy.prepare('SELECT alert_stops FROM config WHERE user_id = ?').get(userId);
      return row ? JSON.parse(row.alert_stops) : null;
    },
    async getTelegram(userId = process.env.DEFAULT_USER_ID || '') {
      const row = await dbProxy.prepare('SELECT telegram FROM config WHERE user_id = ?').get(userId);
      return row ? JSON.parse(row.telegram) : null;
    },
    async getPushbullet(userId = process.env.DEFAULT_USER_ID || '') {
      const row = await dbProxy.prepare('SELECT pushbullet FROM config WHERE user_id = ?').get(userId);
      return row ? JSON.parse(row.pushbullet) : null;
    },
    async getPriceAlerts(userId = process.env.DEFAULT_USER_ID || '') {
      const row = await dbProxy.prepare('SELECT price_alerts FROM config WHERE user_id = ?').get(userId);
      return row ? JSON.parse(row.price_alerts) : null;
    },
    async getWebshare(userId = process.env.DEFAULT_USER_ID || '') {
      const row = await dbProxy.prepare('SELECT webshare FROM config WHERE user_id = ?').get(userId);
      return row ? JSON.parse(row.webshare) : null;
    },
    async saveWebshare(userId, data) {
      await dbProxy.prepare('UPDATE config SET webshare = ? WHERE user_id = ?').run(JSON.stringify(data), userId);
    },
    async getProxyStats() {
      return dbProxy.prepare('SELECT * FROM proxy_stats ORDER BY successes DESC, (CAST(total_response_ms AS REAL) / NULLIF(successes, 0)) ASC').all();
    },
    async upsertProxyStat({ host, ok, responseMs }) {
      const now = new Date().toISOString();
      const row = await dbProxy.prepare('SELECT successes, failures, total_response_ms FROM proxy_stats WHERE host = ?').get(host);
      if (row) {
        await dbProxy.prepare(`
          UPDATE proxy_stats SET
            successes = successes + ?,
            failures = failures + ?,
            total_response_ms = total_response_ms + ?,
            last_used_at = ?,
            last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
            last_fail_at = CASE WHEN NOT ? THEN ? ELSE last_fail_at END
          WHERE host = ?
        `).run(ok ? 1 : 0, ok ? 0 : 1, responseMs || 0, now, ok ? 1 : 0, now, ok ? 0 : 1, now, host);
      } else {
        await dbProxy.prepare(`
          INSERT INTO proxy_stats (host, successes, failures, total_response_ms, last_used_at, last_success_at, last_fail_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(host, ok ? 1 : 0, ok ? 0 : 1, responseMs || 0, now, ok ? now : null, ok ? null : now);
      }
    },
    async clearProxyStats() {
      await dbProxy.prepare('DELETE FROM proxy_stats').run();
    }
  }
};

module.exports = dbProxy;
module.exports.init = init;
