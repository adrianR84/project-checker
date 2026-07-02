// Database migrations — runs on every init, idempotent.
// Each function migrates from one schema version to the next.

const now = () => new Date().toISOString();

/**
 * Migrate from *_check_hours (integer = hours) → *_check_minutes (integer = minutes).
 * Detects the old schema by looking for commit_check_hours column,
 * then ALTER TABLE ADD new columns and copy ×60.
 */
function migrate_hours_to_minutes(db, save) {
  const rows = db.exec('SELECT * FROM config WHERE id = 1');
  if (!rows.length || !rows[0].values.length) return;

  const cols = rows[0].columns;
  if (!cols.includes('commit_check_hours') || cols.includes('commit_check_minutes')) return;

  const vals = rows[0].values[0];
  const row = {};
  cols.forEach((c, i) => { row[c] = vals[i]; });

  db.exec('ALTER TABLE config ADD COLUMN commit_check_minutes INTEGER NOT NULL DEFAULT 360');
  db.exec('ALTER TABLE config ADD COLUMN website_check_minutes INTEGER NOT NULL DEFAULT 1440');
  db.exec('ALTER TABLE config ADD COLUMN twitter_check_minutes INTEGER NOT NULL DEFAULT 1440');

  const cm = (row.commit_check_hours || 6) * 60;
  const wm = (row.website_check_hours || 24) * 60;
  const tm = (row.twitter_check_hours || 24) * 60;
  db.run('UPDATE config SET commit_check_minutes = ?, website_check_minutes = ?, twitter_check_minutes = ? WHERE id = 1', [cm, wm, tm]);
  save();

  console.log(`[${now()}] Migration: *_check_hours → *_check_minutes`);
}

/**
 * Drop old *_check_hours columns after successful migration to minutes.
 */
function drop_old_hours_columns(db, save) {
  const rows = db.exec("SELECT * FROM config WHERE id = 1");
  if (!rows.length || !rows[0].values.length) return;

  const cols = rows[0].columns;
  if (!cols.includes('commit_check_minutes') || !cols.includes('commit_check_hours')) return;

  db.exec('ALTER TABLE config DROP COLUMN commit_check_hours');
  db.exec('ALTER TABLE config DROP COLUMN website_check_hours');
  db.exec('ALTER TABLE config DROP COLUMN twitter_check_hours');
  save();

  console.log(`[${now()}] Migration: dropped old *_check_hours columns`);
}

/**
 * Add log_retention_days column to config (default 7).
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
 * Add last-changed timestamps to projects table.
 */
function add_last_changed_at_columns(db, save) {
  const rows = db.exec("SELECT * FROM projects LIMIT 1");
  if (!rows.length) return;
  const cols = rows[0].columns;
  if (cols.includes('website_last_changed_at')) return;
  db.exec('ALTER TABLE projects ADD COLUMN website_last_changed_at TEXT');
  db.exec('ALTER TABLE projects ADD COLUMN github_last_changed_at TEXT');
  db.exec('ALTER TABLE projects ADD COLUMN twitter_last_changed_at TEXT');
  save();
  console.log(`[${now()}] Migration: added last-changed columns to projects`);
}

/**
 * Add website_confirmed_hash to projects table.
 * Set on manual confirmation; status is "changed" when content differs from it.
 */
function add_confirmed_hashes(db, save) {
  const rows = db.exec("SELECT * FROM projects LIMIT 1");
  if (!rows.length) return;
  const cols = rows[0].columns;
  if (cols.includes('website_confirmed_hash')) return;
  db.exec('ALTER TABLE projects ADD COLUMN website_confirmed_hash TEXT');
  save();
  console.log(`[${now()}] Migration: added confirmed hashes to projects`);
}

/**
 * Drop github_confirmed_hash column (no longer needed).
 */
function drop_github_confirmed_hash(db, save) {
  const rows = db.exec("SELECT * FROM projects LIMIT 1");
  if (!rows.length) return;
  const cols = rows[0].columns;
  if (!cols.includes('github_confirmed_hash')) return;
  db.exec('ALTER TABLE projects DROP COLUMN github_confirmed_hash');
  save();
  console.log(`[${now()}] Migration: dropped github_confirmed_hash from projects`);
}

/**
 * Add twitter_confirmed_hash to projects table.
 * Used to make Twitter errors sticky — error persists until manually confirmed.
 */
function add_twitter_confirmed_hash(db, save) {
  const rows = db.exec("SELECT * FROM projects LIMIT 1");
  if (!rows.length) return;
  const cols = rows[0].columns;
  if (cols.includes('twitter_confirmed_hash')) return;
  db.exec('ALTER TABLE projects ADD COLUMN twitter_confirmed_hash TEXT');
  save();
  console.log(`[${now()}] Migration: added twitter_confirmed_hash to projects`);
}

/**
 * Drop website_content_hash column (not used — content hash lives in check_logs).
 */
function drop_website_content_hash(db, save) {
  const rows = db.exec("SELECT * FROM projects LIMIT 1");
  if (!rows.length) return;
  const cols = rows[0].columns;
  if (!cols.includes('website_content_hash')) return;
  db.exec('ALTER TABLE projects DROP COLUMN website_content_hash');
  save();
  console.log(`[${now()}] Migration: dropped website_content_hash from projects`);
}

/**
 * Run all migrations in order. Safe to call on every init.
 */
function runMigrations(db, save) {
  try { migrate_hours_to_minutes(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { drop_old_hours_columns(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_log_retention_days(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_ui_refresh_seconds(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_last_changed_at_columns(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_confirmed_hashes(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { drop_github_confirmed_hash(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { drop_website_content_hash(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
  try { add_twitter_confirmed_hash(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
}

module.exports = { runMigrations };
