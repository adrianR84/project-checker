// Database migrations — runs on every init, idempotent.
/** Returns the current ISO timestamp. */
const now = () => new Date().toISOString();

// ponytail: shared helper to check if a column exists in a table
function hasColumn(db, table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === col);
}

/** Migration: converts check_logs.resource_id from TEXT to INTEGER via table rebuild. */
function convert_check_logs_resource_id_to_integer(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='check_logs'").get();
  if (!row) return;
  const sql = String(row.sql);
  // Idempotency: skip if resource_id is already INTEGER
  if (/resource_id\s+INTEGER/i.test(sql)) return;
  console.log(`[${now()}] Migration: converting check_logs.resource_id TEXT → INTEGER`);
  try {
    db.exec(`
      BEGIN TRANSACTION;
      ALTER TABLE check_logs RENAME TO _cl_rid_old;
      CREATE TABLE check_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('website', 'github', 'twitter')),
        resource_id INTEGER,
        status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'disabled', 'unavailable', 'deleted', 'changed')),
        http_status INTEGER,
        response_time_ms INTEGER,
        error_message TEXT,
        details TEXT,
        checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO check_logs (
        id, project_id, resource_type, resource_id, status, http_status,
        response_time_ms, error_message, details, checked_at
      )
      SELECT
        old.id,
        old.project_id,
        old.resource_type,
        CASE
          WHEN old.resource_type = 'github' THEN (
            SELECT r.id FROM repos r
            WHERE r.project_id = old.project_id AND r.full_name = old.resource_id
            LIMIT 1
          )
          ELSE NULL
        END,
        old.status,
        old.http_status,
        old.response_time_ms,
        old.error_message,
        old.details,
        old.checked_at
      FROM _cl_rid_old old;
      DROP TABLE _cl_rid_old;
      CREATE INDEX IF NOT EXISTS idx_check_logs_project_resource_date ON check_logs (project_id, resource_type, checked_at);
      COMMIT;
    `);
  } catch (err) {
    console.error(`[${now()}] convert_check_logs_resource_id_to_integer failed: ${err.message}`);
  }
}

/** Migration: rebuilds check_logs to add 'deleted' and 'changed' to status CHECK. */
function fix_check_logs_status_check(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='check_logs'").get();
  if (!row) return;
  if (String(row.sql).indexOf("'deleted'") === -1 || String(row.sql).indexOf("'changed'") === -1) {
    console.log(`[${now()}] Migration: fixing check_logs CHECK constraint`);
    try {
      db.exec(`
        BEGIN TRANSACTION;
        ALTER TABLE check_logs RENAME TO _cl_old;
        CREATE TABLE check_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          resource_type TEXT NOT NULL CHECK (resource_type IN ('website', 'github', 'twitter')),
          resource_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'disabled', 'unavailable', 'deleted', 'changed')),
          http_status INTEGER,
          response_time_ms INTEGER,
          error_message TEXT,
          details TEXT,
          checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        INSERT INTO check_logs SELECT * FROM _cl_old;
        DROP TABLE _cl_old;
        COMMIT;
      `);
    } catch (err) {
      console.error(`[${now()}] fix_check_logs_status_check failed: ${err.message}`);
    }
  }
}

/** Migration: rebuilds event_logs to add 'deleted' to event_type CHECK. */
function fix_rsc_event_type_check(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='event_logs'").get();
  if (!row) return;
  if (String(row.sql).indexOf("'deleted'") === -1) {
    console.log(`[${now()}] Migration: fixing event_logs CHECK constraint`);
    try {
      db.exec(`
        BEGIN TRANSACTION;
        ALTER TABLE event_logs RENAME TO _rsc_old;
        CREATE TABLE event_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          resource_type TEXT NOT NULL CHECK (resource_type IN ('website', 'github', 'twitter')),
          event_type TEXT NOT NULL CHECK (event_type IN ('confirmed', 'changed', 'deleted', 'tag_changed')),
          value TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        INSERT INTO event_logs SELECT * FROM _rsc_old;
        DROP TABLE _rsc_old;
        COMMIT;
      `);
    } catch (err) {
      console.error(`[${now()}] fix_rsc_event_type_check failed: ${err.message}`);
    }
  }
}


/** Migration: adds status column to repos if missing. */
function add_repos_status(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='repos'").get()) return;
  if (hasColumn(db, 'repos', 'status')) return;
  db.exec('ALTER TABLE repos ADD COLUMN status TEXT NOT NULL DEFAULT \'active\'');
}

/** Migration: adds latest_tag column to repos if missing. */
function add_repos_latest_tag(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='repos'").get()) return;
  if (hasColumn(db, 'repos', 'latest_tag')) return;
  db.exec('ALTER TABLE repos ADD COLUMN latest_tag TEXT');
}

/** Migration: adds confirmed column to event_logs if missing. */
function add_rsc_confirmed_column(db) {
  if (hasColumn(db, 'event_logs', 'confirmed')) return;
  db.exec('ALTER TABLE event_logs ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0');
}

/** Migration: creates idx_event_logs_alerting index on event_logs for alert queries. */
function add_rsc_alerting_index(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_event_logs_alerting'").get();
  if (row) return;
  db.exec('CREATE INDEX IF NOT EXISTS idx_event_logs_alerting ON event_logs (resource_type, confirmed, created_at DESC)');
}

/** Migration: renames commit_check_minutes → github_check_minutes and adds alert config columns. */
function rename_commit_to_github_check_and_add_alert_cols(db) {
  // Already migrated to new schema (settings column is the indicator)
  if (hasColumn(db, 'config', 'settings')) return;
  // github_check_minutes column exists means previous migration ran but left flat columns
  if (hasColumn(db, 'config', 'github_check_minutes')) return;
  // Check if _config_old exists from a failed prior run and clean it up
  const oldTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_config_old'").get();
  if (oldTable) {
    db.exec("DROP TABLE IF EXISTS _config_old");
  }
}

/** Migration: creates alert_logs table if missing. */
function add_alert_logs_table(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alert_logs'").get();
  if (row) return;
  db.exec(`
    CREATE TABLE alert_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status_change_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (status_change_id) REFERENCES event_logs(id) ON DELETE CASCADE
    )
  `);
}

/** Migration: rebuilds alert_logs to point FK at event_logs instead of resource_status_changes. */
function fix_alert_logs_fk(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='alert_logs'").get();
  if (!row) return;
  if (String(row.sql).indexOf('resource_status_changes') === -1) return;
  console.log(`[${now()}] Migration: fixing alert_logs FK`);
  try {
    db.exec(`
      BEGIN TRANSACTION;
      ALTER TABLE alert_logs RENAME TO _alert_old;
      CREATE TABLE alert_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status_change_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (status_change_id) REFERENCES event_logs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_alert_logs_status_change_id ON alert_logs (status_change_id, created_at DESC);
      INSERT INTO alert_logs SELECT id, status_change_id, created_at FROM _alert_old;
      DROP TABLE _alert_old;
      COMMIT;
    `);
  } catch (err) {
    console.error(`[${now()}] fix_alert_logs_fk failed: ${err.message}`);
  }
}

/** Migration: rebuilds idx_alert_logs_status_change_id to include created_at DESC. */
function fix_alert_logs_index(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_alert_logs_status_change_id'").get();
  if (!row) return;
  const sql = String(row.sql);
  if (sql.indexOf('created_at') !== -1) return;
  console.log(`[${now()}] Migration: fixing alert_logs index`);
  try {
    db.exec(`
      DROP INDEX IF EXISTS idx_alert_logs_status_change_id;
      CREATE INDEX IF NOT EXISTS idx_alert_logs_status_change_id ON alert_logs (status_change_id, created_at DESC);
    `);
  } catch (err) {
    console.error(`[${now()}] fix_alert_logs_index failed: ${err.message}`);
  }
}

/** Migration: drops redundant columns from alert_logs table (already-migrated DBs only). */
function drop_redundant_alert_logs_cols(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='alert_logs'").get();
  if (!row) return;
  const sql = String(row.sql);
  if (sql.indexOf('project_id') === -1) return;
  console.log(`[${now()}] Migration: dropping redundant columns from alert_logs`);
  try {
    db.exec(`
      BEGIN TRANSACTION;
      ALTER TABLE alert_logs RENAME TO _alert_old;
      CREATE TABLE alert_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status_change_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (status_change_id) REFERENCES event_logs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_alert_logs_status_change_id ON alert_logs (status_change_id, created_at DESC);
      INSERT INTO alert_logs SELECT id, status_change_id, created_at FROM _alert_old;
      DROP TABLE _alert_old;
      COMMIT;
    `);
  } catch (err) {
    console.error(`[${now()}] drop_redundant_alert_logs_cols failed: ${err.message}`);
  }
}

/** Migration: migrates data from resource_status_changes into event_logs and drops old table. */
function rename_rsc_to_event_logs(db) {
  const oldTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_status_changes'").get();
  if (!oldTable) return;
  const newTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_logs'").get();
  if (newTable) return; // event_logs already exists, migration was already done
  console.log(`[${now()}] Migration: migrating resource_status_changes → event_logs`);
  try {
    db.exec(`
      BEGIN TRANSACTION;
      INSERT INTO event_logs (project_id, resource_type, event_type, value, created_at, confirmed)
      SELECT project_id, resource_type, event_type, value, created_at, 0 FROM resource_status_changes;
      DROP TABLE resource_status_changes;
      COMMIT;
    `);
  } catch (err) {
    console.error(`[${now()}] rename_rsc_to_event_logs failed: ${err.message}`);
  }
}

/** Migration: consolidates flat config columns into JSON group columns: settings, check_intervals, alert_intervals, alert_stops. */
function migrate_config_json_groups(db) {
  // Fully migrated: settings column exists
  if (hasColumn(db, 'config', 'settings')) return;
  // settings column doesn't exist — cleanup orphaned _cfg_old from failed run
  const oldTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_cfg_old'").get();
  if (oldTable) db.exec("DROP TABLE IF EXISTS _cfg_old");
}

/** Migration: adds website_content_check column to projects if missing. */
function add_website_content_check(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects' AND sql LIKE '%website_content_check%'").get();
  if (row) return;
  try {
    db.exec('ALTER TABLE projects ADD COLUMN website_content_check INTEGER NOT NULL DEFAULT 1');
  } catch (err) {
    console.error(`[${now()}] add_website_content_check failed: ${err.message}`);
  }
}

/** Migration: drops unused flat columns log_retention_days, ui_refresh_seconds, compact_activity from config. */
function drop_old_config_flat_cols(db) {
  const rows = db.prepare("PRAGMA table_info(config)").all();
  if (!rows) return;
  const cols = rows.map(r => r.name);
  const toDrop = ['log_retention_days', 'ui_refresh_seconds', 'compact_activity'].filter(c => cols.includes(c));
  for (const col of toDrop) {
    try {
      db.exec(`ALTER TABLE config DROP COLUMN ${col}`);
    } catch (err) {
      console.error(`[${now()}] drop_old_config_flat_cols (${col}) failed: ${err.message}`);
    }
  }
}

/** Migration: adds token (JSON) and enabled columns to projects if missing. */
function add_token_and_enabled_columns(db) {
  const rows = db.prepare("PRAGMA table_info(projects)").all();
  if (!rows) return;
  const cols = rows.map(r => r.name);
  if (!cols.includes('token')) {
    try { db.exec("ALTER TABLE projects ADD COLUMN token TEXT"); } catch (e) { console.error(`[${now()}] add_token_and_enabled_columns (token) failed: ${e.message}`); }
  }
  if (!cols.includes('enabled')) {
    try { db.exec("ALTER TABLE projects ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1"); } catch (e) { console.error(`[${now()}] add_token_and_enabled_columns (enabled) failed: ${e.message}`); }
  }
}

/** Migration: creates token_prices table if missing. */
function add_token_prices_table(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_prices'").get();
  if (row) return;
  db.exec(`
    CREATE TABLE token_prices (
      project_id INTEGER PRIMARY KEY,
      symbol TEXT,
      chain TEXT,
      contract TEXT,
      price_usd REAL,
      price_change_h1 REAL,
      price_change_h4 REAL,
      price_change_h6 REAL,
      price_change_h24 REAL,
      liquidity_usd REAL,
      volume_h24 REAL,
      market_cap REAL,
      pair_created_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
}

/** Migration: adds price_alerts column to config if missing. */
function add_price_alerts_column(db) {
  if (hasColumn(db, 'config', 'price_alerts')) return;
  db.exec("ALTER TABLE config ADD COLUMN price_alerts TEXT NOT NULL DEFAULT '{\"alerts\":[{\"price_change\":10,\"price_interval\":5,\"enabled\":1,\"telegram\":1,\"pushbullet\":1,\"log\":1},{\"price_change\":25,\"price_interval\":15,\"enabled\":1,\"telegram\":1,\"pushbullet\":1,\"log\":1},{\"price_change\":50,\"price_interval\":60,\"enabled\":1,\"telegram\":1,\"pushbullet\":1,\"log\":1}]}'");
}

/** Migration: adds 'price' to resource_type CHECK in check_logs via table rebuild. */
function add_price_to_check_logs_resource_type(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='check_logs'").get();
  if (!row) return;
  if (String(row.sql).includes("'price'")) return;
  console.log(`[${now()}] Migration: adding 'price' to check_logs.resource_type CHECK`);
  try {
    db.exec(`
      ALTER TABLE check_logs RENAME TO _cl_price_old;
      CREATE TABLE check_logs (
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
      INSERT INTO check_logs SELECT * FROM _cl_price_old;
      DROP TABLE _cl_price_old;
      CREATE INDEX IF NOT EXISTS idx_check_logs_project_resource_date ON check_logs (project_id, resource_type, checked_at);
    `);
  } catch (err) {
    console.error(`[${now()}] add_price_to_check_logs_resource_type failed: ${err.message}`);
  }
}

/** Migration: adds 'price' to resource_type CHECK in event_logs via table rebuild. */
function add_price_to_event_logs_resource_type(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='event_logs'").get();
  if (!row) return;
  if (String(row.sql).includes("'price'")) return;
  console.log(`[${now()}] Migration: adding 'price' to event_logs.resource_type CHECK`);
  try {
    db.exec(`
      ALTER TABLE event_logs RENAME TO _el_price_old;
      CREATE TABLE event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('website', 'github', 'twitter', 'price')),
        event_type TEXT NOT NULL CHECK (event_type IN ('confirmed', 'changed', 'deleted', 'tag_changed')),
        value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        confirmed INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO event_logs SELECT * FROM _el_price_old;
      DROP TABLE _el_price_old;
      CREATE INDEX IF NOT EXISTS idx_event_logs_project_resource ON event_logs (project_id, resource_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_event_logs_alerting ON event_logs (resource_type, confirmed, created_at DESC);
    `);
  } catch (err) {
    console.error(`[${now()}] add_price_to_event_logs_resource_type failed: ${err.message}`);
  }
}

/** Migration: adds telegram and pushbullet columns to config if missing. */
function add_notification_config_cols(db) {
  const rows = db.prepare("PRAGMA table_info(config)").all();
  if (!rows) return;
  const cols = rows.map(r => r.name);
  if (cols.includes('telegram')) return;
  try {
    db.exec("ALTER TABLE config ADD COLUMN telegram TEXT NOT NULL DEFAULT '{\"bot_token\":\"\",\"chat_id\":\"\",\"enabled\":false}'");
  } catch (err) {
    console.error(`[${now()}] add_notification_config_cols (telegram) failed: ${err.message}`);
  }
  try {
    db.exec("ALTER TABLE config ADD COLUMN pushbullet TEXT NOT NULL DEFAULT '{\"access_token\":\"\",\"enabled\":false}'");
  } catch (err) {
    console.error(`[${now()}] add_notification_config_cols (pushbullet) failed: ${err.message}`);
  }
}

/** Runs all idempotent migrations sequentially, logging errors but never throwing. */
async function runMigrations(db) {
  try { await rename_rsc_to_event_logs(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await fix_alert_logs_fk(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_repos_status(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_repos_latest_tag(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await convert_check_logs_resource_id_to_integer(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await fix_check_logs_status_check(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await fix_rsc_event_type_check(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_rsc_confirmed_column(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_alert_logs_table(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await drop_redundant_alert_logs_cols(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await fix_alert_logs_index(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await migrate_config_json_groups(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_website_content_check(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_price_alerts_column(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_price_to_check_logs_resource_type(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_price_to_event_logs_resource_type(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_notification_config_cols(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await drop_old_config_flat_cols(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_token_and_enabled_columns(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { await add_token_prices_table(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
}

module.exports = { runMigrations };
