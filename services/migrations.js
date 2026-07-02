// Database migrations — runs on every init, idempotent.
// Each function migrates from one schema version to the next.

const now = () => new Date().toISOString();

/**
 * Add log_retention_days column to config (default 7).
 * Integrated into db.js CREATE TABLE for new installs; kept here for existing DBs.
 */
function add_log_retention_days(db, save) {
  const rows = db.exec('SELECT * FROM config WHERE id = 1');
  if (!rows.length) return;
  const cols = rows[0].columns;
  if (cols.includes('log_retention_days')) return;
  db.exec('ALTER TABLE config ADD COLUMN log_retention_days INTEGER NOT NULL DEFAULT 7');
  save();
  console.log(`[${now()}] Migration: added log_retention_days column`);
}

/**
 * Add ui_refresh_seconds column to config (default 60 = 1 minute).
 * Integrated into db.js CREATE TABLE for new installs; kept here for existing DBs.
 */
function add_ui_refresh_seconds(db, save) {
  const rows = db.exec('SELECT * FROM config WHERE id = 1');
  if (!rows.length) return;
  const cols = rows[0].columns;
  if (cols.includes('ui_refresh_seconds')) return;
  db.exec('ALTER TABLE config ADD COLUMN ui_refresh_seconds INTEGER NOT NULL DEFAULT 60');
  save();
  console.log(`[${now()}] Migration: added ui_refresh_seconds column`);
}

/**
 * Create resource_status_changes table.
 * Integrated into db.js for new installs; kept here for existing DBs.
 */
function add_resource_status_changes(db, save) {
  const rows = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_status_changes'");
  if (rows.length && rows[0].values.length) return;
  db.exec(`
    CREATE TABLE resource_status_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('website', 'github', 'twitter')),
      event_type TEXT NOT NULL CHECK (event_type IN ('confirmed', 'changed')),
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX idx_rsc_project_resource
    ON resource_status_changes (project_id, resource_type, created_at DESC)
  `);
  save();
  console.log(`[${now()}] Migration: created resource_status_changes table`);
}

/**
 * Back-populate resource_status_changes from old projects columns.
 * No-op on current schema (columns already dropped).
 */
function backfill_resource_status_changes(db, save) {
  const rows = db.exec("SELECT * FROM projects LIMIT 1");
  if (!rows.length) return;
  const cols = rows[0].columns;
  if (!cols.includes('website_confirmed_hash') && !cols.includes('twitter_confirmed_hash') &&
      !cols.includes('website_last_changed_at') && !cols.includes('github_last_changed_at') &&
      !cols.includes('twitter_last_changed_at')) return;

  const projects = db.exec("SELECT id, website_confirmed_hash, twitter_confirmed_hash, website_last_changed_at, github_last_changed_at, twitter_last_changed_at FROM projects");
  if (!projects.length || !projects[0].values.length) return;

  const r = projects[0];
  const pcols = r.columns;
  const idx = {
    id: pcols.indexOf('id'),
    wch: pcols.indexOf('website_confirmed_hash'),
    tch: pcols.indexOf('twitter_confirmed_hash'),
    wlch: pcols.indexOf('website_last_changed_at'),
    glch: pcols.indexOf('github_last_changed_at'),
    tlch: pcols.indexOf('twitter_last_changed_at'),
  };

  const insert = db.prepare(
    "INSERT INTO resource_status_changes (project_id, resource_type, event_type, value, created_at) VALUES (?, ?, ?, ?, ?)"
  );

  let count = 0;
  for (const row of r.values) {
    const pid = row[idx.id];

    if (idx.wch >= 0 && row[idx.wch]) {
      insert.run(pid, 'website', 'confirmed', row[idx.wch], row[idx.wlch] || now());
      count++;
    }
    if (idx.tch >= 0 && row[idx.tch]) {
      insert.run(pid, 'twitter', 'confirmed', row[idx.tch], row[idx.tlch] || now());
      count++;
    }
    if (idx.wlch >= 0 && row[idx.wlch]) {
      insert.run(pid, 'website', 'changed', '', row[idx.wlch]);
      count++;
    }
    if (idx.glch >= 0 && row[idx.glch]) {
      insert.run(pid, 'github', 'changed', '', row[idx.glch]);
      count++;
    }
    if (idx.tlch >= 0 && row[idx.tlch]) {
      insert.run(pid, 'twitter', 'changed', '', row[idx.tlch]);
      count++;
    }
  }

  if (count) {
    save();
    console.log(`[${now()}] Migration: back-filled ${count} status-change rows into resource_status_changes`);
  }
}

/**
 * Run all migrations in order. Safe to call on every init.
 */
function runMigrations(db, save) {
  try { add_log_retention_days(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_ui_refresh_seconds(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_resource_status_changes(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  //try { backfill_resource_status_changes(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  }

module.exports = { runMigrations };
