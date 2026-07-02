// Database migrations — runs on every init, idempotent.
// Each function migrates from one schema version to the next.

const now = () => new Date().toISOString();

/**
 * Back-populate resource_status_changes from the old projects columns.
 * For each non-null *_confirmed_hash → insert a 'confirmed' event.
 * For each non-null *_last_changed_at → insert a 'changed' event (with value = '').
 * This preserves existing history before the columns are dropped.
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
  //try { backfill_resource_status_changes(db, save); } catch (e) { console.error(`[${now()}] Migration error: ${e.message}`); }
}

module.exports = { runMigrations };
