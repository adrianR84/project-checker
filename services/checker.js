// Health-check services: website, github, twitter
const db = require('./db');
const { createHash } = require('crypto');

const now = () => new Date().toISOString();

function logCheck(projectId, resourceType, resourceId, result) {
  db.prepare(`
    INSERT INTO check_logs (project_id, resource_type, resource_id, status, http_status, response_time_ms, error_message, details, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    resourceType,
    resourceId || null,
    result.status,
    result.http_status || null,
    result.response_time_ms || null,
    result.error_message || null,
    result.details ? JSON.stringify(result.details) : null,
    now()
  );
}

// Check a website URL: GET + MD5 hash of body, compare with the confirmed hash.
// Status is "changed" if content differs from the confirmed hash (sticky until manually confirmed).
// Status is "error" if the request fails (sticky until manually confirmed).
// Manual confirm updates confirmed_hash to current content → next check returns "ok".
async function checkWebsite(url, projectId) {
  const start = Date.now();
  if (!url) {
    return { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: 'No URL provided', details: null };
  }

  // Get confirmed hash from project row (set on manual confirm)
  let confirmedHash = null;
  if (projectId) {
    const proj = db.prepare('SELECT website_confirmed_hash FROM projects WHERE id = ?').get(projectId);
    confirmedHash = proj?.website_confirmed_hash || null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'project-checker/1.0' }
    });
    clearTimeout(timeout);
    const response_time_ms = Date.now() - start;

    let contentHash = null;
    if (res.ok) {
      try {
        const bodyText = await res.text();
        contentHash = createHash('md5').update(bodyText).digest('hex');
      } catch (_) {}
    }

    // changed if content differs from confirmed hash (sticky — stays changed until user confirms)
    const changed = confirmedHash && contentHash && confirmedHash !== contentHash;
    const status = res.ok ? (changed ? 'changed' : 'ok') : 'error';

    // Update last_changed_at whenever content differs from confirmed (arms alert system)
    if (contentHash !== confirmedHash && projectId) {
      db.prepare('UPDATE projects SET website_last_changed_at = ? WHERE id = ?').run(now(), projectId);
    }

    return {
      status,
      http_status: res.status,
      response_time_ms,
      error_message: res.ok ? null : `HTTP ${res.status}`,
      details: contentHash ? { content_hash: contentHash } : null,
    };
  } catch (err) {
    const response_time_ms = Date.now() - start;
    return { status: 'error', http_status: null, response_time_ms, error_message: err.message, details: null };
  }
}

// Check a single GitHub repo: fetch latest commit, compare to stored, update if changed
async function checkGithubRepo(fullName, projectId) {
  const { fetchCommitHistory } = require('./github');
  try {
    const history = await fetchCommitHistory(fullName);
    const repo = db.prepare('SELECT * FROM repos WHERE full_name = ? AND project_id = ?').get(fullName, projectId);

    let status = 'ok';
    let details = null;

    if (repo && repo.latest_commit_sha !== history.latest_commit_sha) {
      // New commit detected — update repo
      db.prepare(`
        UPDATE repos SET
          first_commit_date = ?,
          latest_commit_date = ?,
          latest_commit_sha = ?,
          latest_commit_message = ?,
          total_commits = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        history.first_commit_date,
        history.latest_commit_date,
        history.latest_commit_sha,
        history.latest_commit_message,
        history.total_commits,
        now(),
        repo.id
      );
      details = { changed: true, previous_sha: repo.latest_commit_sha, new_sha: history.latest_commit_sha };
      if (projectId) {
        db.prepare('UPDATE projects SET github_last_changed_at = ? WHERE id = ?').run(now(), projectId);
      }
    } else if (!repo) {
      details = { note: 'Repo not in local DB, no update' };
    }

    return { status, http_status: 200, response_time_ms: 0, error_message: null, details };
  } catch (err) {
    return { status: 'error', http_status: null, response_time_ms: 0, error_message: err.message };
  }
}

// Check Twitter profile page.
// Uses sticky confirm pattern: error sticks until manually confirmed.
async function checkTwitter(url, projectId) {
  const start = Date.now();
  if (!url) {
    return { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: 'No URL provided' };
  }

  let confirmedHash = null;
  if (projectId) {
    const proj = db.prepare('SELECT twitter_confirmed_hash FROM projects WHERE id = ?').get(projectId);
    confirmedHash = proj?.twitter_confirmed_hash || null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; project-checker/1.0)' }
    });
    clearTimeout(timeout);
    const response_time_ms = Date.now() - start;
    const newStatus = res.ok ? 'ok' : 'error';

    // Sticky confirm pattern: if new status differs from confirmed, return 'changed'
    // until user confirms. The confirmed_hash is only updated on manual confirm.
    const changed = confirmedHash !== null && newStatus !== confirmedHash;
    const status = changed ? 'changed' : (confirmedHash || newStatus);

    // Update last_changed_at whenever status differs from confirmed (arms the alert system)
    if (newStatus !== confirmedHash && projectId) {
      db.prepare('UPDATE projects SET twitter_last_changed_at = ? WHERE id = ?').run(now(), projectId);
    }

    return {
      status,
      http_status: res.status,
      response_time_ms,
      error_message: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const response_time_ms = Date.now() - start;
    return { status: 'error', http_status: null, response_time_ms, error_message: err.message };
  }
}

module.exports = {
  checkWebsite,
  checkGithubRepo,
  checkTwitter,
  logCheck
};
