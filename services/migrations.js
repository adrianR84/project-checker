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
          event_type TEXT NOT NULL CHECK (event_type IN ('changed', 'deleted', 'tag_changed')),
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
  if (String(row.sql).indexOf('resource_status_changes') === -1 && String(row.sql).indexOf('_el_price_old') === -1) return;
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

/** Migration: adds price_enabled column to projects if missing. */
function add_price_enabled(db) {
  if (hasColumn(db, 'projects', 'price_enabled')) return;
  try {
    db.exec('ALTER TABLE projects ADD COLUMN price_enabled INTEGER NOT NULL DEFAULT 1');
  } catch (err) {
    console.error(`[${now()}] add_price_enabled failed: ${err.message}`);
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

/** Migration: creates twitter_posts table if missing (for posts-check feature). */
function add_twitter_posts_table(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='twitter_posts'").get();
  if (row) return;
  try {
    db.exec(`
      CREATE TABLE twitter_posts (
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
      )
    `);
  } catch (err) {
    console.error(`[${now()}] add_twitter_posts_table failed: ${err.message}`);
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

/** Migration: creates token_prices_alerts table if missing. */
function add_token_prices_alerts_table(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_prices_alerts'").get();
  if (row) return;
  db.exec(`
    CREATE TABLE token_prices_alerts (
      project_id INTEGER NOT NULL,
      price_change REAL NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, price_change)
    )
  `);
}

/** Migration: adds price_alerts column to config if missing. */
function add_price_alerts_column(db) {
  if (hasColumn(db, 'config', 'price_alerts')) return;
  db.exec("ALTER TABLE config ADD COLUMN price_alerts TEXT NOT NULL DEFAULT '{\"alerts\":[{\"price_for\":\"6h\",\"price_change\":10,\"price_interval\":5,\"enabled\":1,\"telegram\":1,\"pushbullet\":1,\"log\":1},{\"price_for\":\"6h\",\"price_change\":25,\"price_interval\":15,\"enabled\":1,\"telegram\":1,\"pushbullet\":1,\"log\":1},{\"price_for\":\"6h\",\"price_change\":50,\"price_interval\":60,\"enabled\":1,\"telegram\":1,\"pushbullet\":1,\"log\":1}]}'");
}

/** Migration: adds 'price' to resource_type CHECK in check_logs via table rebuild. */
function add_price_to_check_logs_resource_type(db) {
  // Target state: check_logs exists and already includes 'price'
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='check_logs'").get();
  if (row && String(row.sql).includes("'price'")) return;
  // Cleanup orphaned temp table from a prior interrupted run
  const orphan = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_cl_price_old'").get();
  if (orphan) {
    try { db.exec("DROP TABLE IF EXISTS _cl_price_old"); } catch (_) {}
  }
  if (!row) return;
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
  // Target state: event_logs exists and already includes 'price'
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='event_logs'").get();
  if (row && String(row.sql).includes("'price'")) return;
  // Cleanup orphaned temp table from a prior interrupted run
  const orphan = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_el_price_old'").get();
  if (orphan) {
    try { db.exec("DROP TABLE IF EXISTS _el_price_old"); } catch (_) {}
  }
  if (!row) return;
  console.log(`[${now()}] Migration: adding 'price' to event_logs.resource_type CHECK`);
  try {
    db.exec(`
      ALTER TABLE event_logs RENAME TO _el_price_old;
      CREATE TABLE event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('website', 'github', 'twitter', 'price')),
        event_type TEXT NOT NULL CHECK (event_type IN ('changed', 'deleted', 'tag_changed')),
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

/** Migration: adds user_id column to projects if missing. */
function add_user_id_to_projects(db) {
  if (hasColumn(db, 'projects', 'user_id')) return;
  db.exec('ALTER TABLE projects ADD COLUMN user_id TEXT NOT NULL DEFAULT \'\'');
}

/** Migration: adds user_id column to config if missing. */
function add_user_id_to_config(db) {
  if (hasColumn(db, 'config', 'user_id')) return;
  db.exec('ALTER TABLE config ADD COLUMN user_id TEXT NOT NULL DEFAULT \'\'');
}

/** Migration: adds index on projects.user_id. */
function add_projects_user_id_index(db) {
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_user_id'").get();
  if (idx) return;
  db.exec('CREATE INDEX idx_projects_user_id ON projects (user_id)');
}

/** Migration: adds index on config.user_id. */
function add_config_user_id_index(db) {
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_config_user_id'").get();
  if (idx) return;
  db.exec('CREATE INDEX idx_config_user_id ON config (user_id)');
}

/** Migration: compacts flat URL/content columns into JSON cols, renames price_enabled → token_enabled. */
function compact_projects_url_cols(db) {
  const rows = db.prepare("PRAGMA table_info(projects)").all();
  if (!rows) return;
  const cols = rows.map(r => r.name);

  // Step 1: add new JSON cols if missing
  if (!cols.includes('website')) {
    try { db.exec("ALTER TABLE projects ADD COLUMN website TEXT"); } catch (e) { console.error(`[${now()}] compact (website) failed: ${e.message}`); }
  }
  if (!cols.includes('github')) {
    try { db.exec("ALTER TABLE projects ADD COLUMN github TEXT"); } catch (e) { console.error(`[${now()}] compact (github) failed: ${e.message}`); }
  }
  if (!cols.includes('twitter')) {
    try { db.exec("ALTER TABLE projects ADD COLUMN twitter TEXT"); } catch (e) { console.error(`[${now()}] compact (twitter) failed: ${e.message}`); }
  }
  if (!cols.includes('telegram')) {
    try { db.exec("ALTER TABLE projects ADD COLUMN telegram TEXT"); } catch (e) { console.error(`[${now()}] compact (telegram) failed: ${e.message}`); }
  }

  // Step 2: copy flat data into JSON cols (idempotent — only runs if old cols still exist)
  if (cols.includes('website_url')) {
    try {
      db.exec(`
        UPDATE projects SET
          website = CASE WHEN website_url IS NOT NULL
            THEN json_object('url', website_url, 'cc', COALESCE(website_content_check, 1))
            ELSE NULL END
        WHERE website IS NULL AND website_url IS NOT NULL
      `);
    } catch (e) { console.error(`[${now()}] compact (website data) failed: ${e.message}`); }
  }
  if (cols.includes('github_url')) {
    try {
      db.exec(`
        UPDATE projects SET
          github = CASE WHEN github_url IS NOT NULL
            THEN json_object('url', github_url)
            ELSE NULL END
        WHERE github IS NULL AND github_url IS NOT NULL
      `);
    } catch (e) { console.error(`[${now()}] compact (github data) failed: ${e.message}`); }
  }
  if (cols.includes('twitter_url')) {
    try {
      db.exec(`
        UPDATE projects SET
          twitter = CASE WHEN twitter_url IS NOT NULL
            THEN json_object('url', twitter_url, 'pc', COALESCE(twitter_enabled, 1))
            ELSE NULL END
        WHERE twitter IS NULL AND twitter_url IS NOT NULL
      `);
    } catch (e) { console.error(`[${now()}] compact (twitter data) failed: ${e.message}`); }
  }
  if (cols.includes('telegram_url')) {
    try {
      db.exec(`
        UPDATE projects SET
          telegram = CASE WHEN telegram_url IS NOT NULL
            THEN json_object('url', telegram_url)
            ELSE NULL END
        WHERE telegram IS NULL AND telegram_url IS NOT NULL
      `);
    } catch (e) { console.error(`[${now()}] compact (telegram data) failed: ${e.message}`); }
  }

  // Step 3: drop old flat URL columns (wrapped in try/catch for SQLite < 3.35)
  const oldUrlCols = ['website_url', 'github_url', 'twitter_url', 'telegram_url'];
  const currentCols = db.prepare("PRAGMA table_info(projects)").all().map(r => r.name);
  for (const col of oldUrlCols) {
    if (currentCols.includes(col)) {
      try { db.exec(`ALTER TABLE projects DROP COLUMN ${col}`); } catch (e) {
        console.error(`[${now()}] compact (drop ${col}) failed: ${e.message}`);
      }
    }
  }
  // Drop website_content_check (merged into website.cc); twitter_enabled stays as flat col for WHERE filtering
  const extraCols = ['website_content_check'];
  const currentCols2 = db.prepare("PRAGMA table_info(projects)").all().map(r => r.name);
  for (const col of extraCols) {
    if (currentCols2.includes(col)) {
      try { db.exec(`ALTER TABLE projects DROP COLUMN ${col}`); } catch (e) {
        console.error(`[${now()}] compact (drop ${col}) failed: ${e.message}`);
      }
    }
  }

  // Step 4: rename price_enabled → token_enabled via table rebuild
  // Also handles the case where token_enabled was already added as a separate column
  // (e.g. add_price_enabled ran previously) and both co-exist — in that case drop price_enabled.
  const currentCols3 = db.prepare("PRAGMA table_info(projects)").all().map(r => r.name);
  const hasPriceEnabled = currentCols3.includes('price_enabled');
  const hasTokenEnabled = currentCols3.includes('token_enabled');

  if (hasPriceEnabled && !hasTokenEnabled) {
    // True rename: price_enabled exists, token_enabled does not
    // Use explicit column list — _proj_old may be missing columns added by later migrations
    console.log(`[${now()}] Migration: renaming price_enabled → token_enabled`);
    try {
      db.exec(`
        BEGIN TRANSACTION;
        ALTER TABLE projects RENAME TO _proj_old;
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          user_id TEXT NOT NULL DEFAULT '',
          website TEXT,
          github TEXT,
          twitter TEXT,
          telegram TEXT,
          website_enabled INTEGER NOT NULL DEFAULT 1,
          github_enabled INTEGER NOT NULL DEFAULT 1,
          twitter_enabled INTEGER NOT NULL DEFAULT 1,
          telegram_enabled INTEGER NOT NULL DEFAULT 1,
          token TEXT,
          token_enabled INTEGER NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO projects (id, name, user_id, website, github, twitter, telegram,
          website_enabled, github_enabled, twitter_enabled, telegram_enabled,
          token, enabled, created_at, updated_at,
          token_enabled)
        SELECT id, name, user_id, website, github, twitter, telegram,
          website_enabled, github_enabled,
          COALESCE(twitter_enabled, 1) AS twitter_enabled,
          telegram_enabled,
          token, enabled, created_at, updated_at,
          price_enabled AS token_enabled
        FROM _proj_old;
        DROP TABLE _proj_old;
        COMMIT;
      `);
    } catch (e) {
      console.error(`[${now()}] compact (rename price_enabled) failed: ${e.message}`);
    }
  } else if (hasPriceEnabled && hasTokenEnabled) {
    // Both co-exist — drop the old price_enabled column
    console.log(`[${now()}] Migration: dropping obsolete price_enabled column (token_enabled already present)`);
    try { db.exec("ALTER TABLE projects DROP COLUMN price_enabled"); } catch (e) {
      console.error(`[${now()}] compact (drop price_enabled) failed: ${e.message}`);
    }
  }
}

/** Migration: drops repo_name column from repos via table rebuild (idempotent). */
function drop_repos_repo_name_col(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='repos'").get()) return;
  const row = db.prepare("PRAGMA table_info(repos)").all();
  const cols = row.map(r => r.name);
  if (!cols.includes('repo_name')) return; // already removed
  console.log(`[${now()}] Migration: dropping repo_name from repos`);
  try {
    db.exec(`
      BEGIN TRANSACTION;
      ALTER TABLE repos RENAME TO _repos_old;
      CREATE TABLE repos (
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
      INSERT INTO repos (id, project_id, full_name, repo_url, description, default_branch,
        first_commit_date, latest_commit_date, total_commits, latest_commit_sha,
        latest_commit_message, pushed_at, stars_count, language, status, latest_tag,
        created_at, updated_at)
      SELECT id, project_id, full_name, repo_url, description, default_branch,
        first_commit_date, latest_commit_date, total_commits, latest_commit_sha,
        latest_commit_message, pushed_at, stars_count, language, status, latest_tag,
        created_at, updated_at
      FROM _repos_old;
      DROP TABLE _repos_old;
      COMMIT;
    `);
  } catch (err) {
    console.error(`[${now()}] drop_repos_repo_name_col failed: ${err.message}`);
  }
}

/** Runs all idempotent migrations sequentially, logging errors but never throwing. */
async function runMigrations(db) {
  // try { await rename_rsc_to_event_logs(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await fix_alert_logs_fk(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_repos_status(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_repos_latest_tag(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await convert_check_logs_resource_id_to_integer(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await fix_check_logs_status_check(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await fix_rsc_event_type_check(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_rsc_confirmed_column(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_alert_logs_table(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await drop_redundant_alert_logs_cols(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await fix_alert_logs_index(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await migrate_config_json_groups(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_website_content_check(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_price_alerts_column(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_price_enabled(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  //try { await add_price_to_check_logs_resource_type(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  //try { await add_price_to_event_logs_resource_type(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_notification_config_cols(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await drop_old_config_flat_cols(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_token_and_enabled_columns(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_token_prices_table(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  // try { await add_token_prices_alerts_table(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_user_id_to_projects(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_user_id_to_config(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { compact_projects_url_cols(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { drop_repos_repo_name_col(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_projects_user_id_index(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_config_user_id_index(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_twitter_posts_table(db); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
}

module.exports = { runMigrations };
