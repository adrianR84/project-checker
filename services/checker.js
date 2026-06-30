// Health-check services: website, github, twitter
const db = require('../db');

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

// Check a website URL via HEAD request
async function checkWebsite(url) {
  const start = Date.now();
  if (!url) {
    return { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: 'No URL provided' };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'project-checker/1.0' }
    });
    clearTimeout(timeout);
    const response_time_ms = Date.now() - start;
    if (res.ok) {
      return { status: 'ok', http_status: res.status, response_time_ms, error_message: null };
    }
    return { status: 'error', http_status: res.status, response_time_ms, error_message: `HTTP ${res.status}` };
  } catch (err) {
    const response_time_ms = Date.now() - start;
    return { status: 'error', http_status: null, response_time_ms, error_message: err.message };
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
    } else if (!repo) {
      details = { note: 'Repo not in local DB, no update' };
    }

    return { status, http_status: 200, response_time_ms: 0, error_message: null, details };
  } catch (err) {
    return { status: 'error', http_status: null, response_time_ms: 0, error_message: err.message };
  }
}

// Check Twitter profile page
async function checkTwitter(url) {
  const start = Date.now();
  if (!url) {
    return { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: 'No URL provided' };
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
    if (res.ok) {
      return { status: 'ok', http_status: res.status, response_time_ms, error_message: null };
    }
    return { status: 'error', http_status: res.status, response_time_ms, error_message: `HTTP ${res.status}` };
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