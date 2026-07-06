// Health-check services: website, github, twitter
const db = require('./db');
const { createHash } = require('crypto');
const { execSync } = require('child_process');
const { JSDOM } = require('jsdom');
// ponytail: cached defuddle availability, checked once on first Twitter check
let _defuddleAvailable = undefined;

/** Returns the current ISO timestamp. */
const now = () => new Date().toISOString();

/**
 * Extracts stable meta tags from HTML to use as a content fingerprint.
 * Only hashes <title> and Open Graph meta tags — ignores dynamic,
 * timestamps, ads, and other noise that changes on every request.
 */
function extractStableMeta(html) {
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const parts = [];

    const title = doc.querySelector('title');
    if (title?.textContent.trim()) parts.push('T:' + title.textContent.trim());

    const ogSelectors = [
      // Open Graph
      'meta[property="og:title"]',
      'meta[property="og:description"]',
      'meta[property="og:image"]',
      'meta[property="og:url"]',
      'meta[property="og:type"]',
      'meta[property="og:site_name"]',
      'meta[property="og:locale"]',
      'meta[property="og:updated_time"]',
      'meta[property="og:video"]',
      // Twitter
      'meta[name="twitter:card"]',
      'meta[name="twitter:site"]',
      'meta[name="twitter:creator"]',
      'meta[name="twitter:title"]',
      'meta[name="twitter:description"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:alt"]',
      // Article meta
      'meta[name="description"]',
      'meta[name="robots"]',
      'meta[name="author"]',
      'meta[property="article:published_time"]',
      'meta[property="article:modified_time"]',
      // Canonical
      'link[rel="canonical"]',
    ];

    for (const sel of ogSelectors) {
      const el = doc.querySelector(sel);
      const val = el?.getAttribute('content')?.trim();
      if (val) parts.push(`${sel}:${val}`);
    }

    // Canonical href
    const canonical = doc.querySelector('link[rel="canonical"]');
    if (canonical?.href?.trim()) parts.push(`canonical:${canonical.href.trim()}`);

    // Stable body signals
    const h1 = doc.querySelector('h1');
    if (h1?.textContent.trim()) parts.push(`H1:${h1.textContent.trim()}`);

    // JSON-LD schema — highly stable structured data
    const ldJson = doc.querySelector('script[type="application/ld+json"]');
    if (ldJson?.textContent.trim()) {
      try { parts.push(`LD+JSON:${JSON.stringify(JSON.parse(ldJson.textContent))}`); } catch (_) {}
    }

    // First meaningful paragraph from article or main (clipped to 300 chars to avoid noise)
    const articleBody = doc.querySelector('article p, main p');
    if (articleBody?.textContent.trim()) {
      const clipped = articleBody.textContent.trim().slice(0, 300);
      parts.push(`FIRSTP:${clipped}`);
    }

    return parts.join('|');
  } catch {
    return '';
  }
}

/** Inserts a status-change event into event_logs for a project's resource. */
async function recordStatusChange(projectId, resourceType, eventType, value) {
  await db.prepare(
    "INSERT INTO event_logs (project_id, resource_type, event_type, value, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(projectId, resourceType, eventType, typeof value === 'string' ? value : JSON.stringify(value), now());
}

/** Persists a health-check result to check_logs. */
async function logCheck(projectId, resourceType, resourceId, result) {
  await db.prepare(`
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

// Check a website URL: GET + optional MD5 hash of body.
/** Checks a website via GET, optionally hashing body to detect content changes. */
async function checkWebsite(url, projectId, contentCheck = true) {
  const start = Date.now();
  if (!url) {
    return { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: 'No URL provided', details: null };
  }

  let lastHash = null;
  let lastHttpStatus = null;
  if (contentCheck && projectId) {
    const row = await db.prepare(
      "SELECT details, http_status FROM check_logs WHERE project_id = ? AND resource_type = 'website' ORDER BY checked_at DESC LIMIT 1"
    ).get(projectId);
    if (row?.details) {
      try { lastHash = JSON.parse(row.details).content_hash || null; } catch (_) {}
    }
    lastHttpStatus = row?.http_status ?? null;
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
    if (contentCheck && res.ok) {
      try {
        const bodyText = await res.text();
        const stableMeta = extractStableMeta(bodyText);
        contentHash = createHash('md5').update(stableMeta).digest('hex');
      } catch (_) {}
    }

    let status;
    if (contentCheck) {
      const changed = lastHash && contentHash && lastHash !== contentHash;
      status = res.ok ? (changed ? 'changed' : 'ok') : 'error';
      if (changed && projectId) {
        recordStatusChange(projectId, 'website', 'changed', { bh: lastHash, ah: contentHash, bhs: lastHttpStatus, ahs: res.status });
      }
    } else {
      status = res.ok ? 'ok' : 'error';
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

/** Checks a GitHub repo for new commits or tags and records status changes. */
async function checkGithubRepo(fullName, projectId) {
  const { fetchCommitHistory, fetchLatestTag } = require('./github');
  try {
    const history = await fetchCommitHistory(fullName);
    const latestTag = await fetchLatestTag(fullName);
    const repo = await db.prepare('SELECT * FROM repos WHERE full_name = ? AND project_id = ?').get(fullName, projectId);

    let status = 'ok';
    let details = null;

    // Tag change detection
    if (repo && repo.latest_tag !== latestTag) {
      const ts = now();
      await db.prepare('UPDATE repos SET latest_tag = ?, updated_at = ? WHERE id = ?').run(latestTag, ts, repo.id);
      if (projectId && repo.latest_tag) {
        recordStatusChange(projectId, 'github', 'tag_changed', { repo_name: fullName, ot: repo.latest_tag, nt: latestTag });
      }
      details = { tag_changed: true, old_tag: repo.latest_tag, new_tag: latestTag };
      status = 'changed';
    } else if (latestTag !== null && !repo?.latest_tag) {
      await db.prepare('UPDATE repos SET latest_tag = ? WHERE id = ?').run(latestTag, repo.id);
    }

    if (repo && repo.latest_commit_sha !== history.latest_commit_sha) {
      await db.prepare(`
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
      details = { ...details, changed: true, previous_sha: repo.latest_commit_sha, new_sha: history.latest_commit_sha };
      if (projectId && repo.latest_commit_sha) {
        recordStatusChange(projectId, 'github', 'changed', { repo_name: fullName, sha: history.latest_commit_sha });
      }
    } else if (!repo) {
      details = { note: 'Repo not in local DB, no update' };
    }

    return { status, http_status: 200, response_time_ms: 0, error_message: null, details };
  } catch (err) {
    // 404 = repo was deleted from GitHub
    if (err.message && err.message.includes('404')) {
      const repo = await db.prepare('SELECT * FROM repos WHERE full_name = ? AND project_id = ?').get(fullName, projectId);
      if (repo && repo.status !== 'deleted') {
        const ts = now();
        await db.prepare("UPDATE repos SET status = 'deleted', updated_at = ? WHERE id = ?").run(ts, repo.id);
        if (projectId) {
          try {
            recordStatusChange(projectId, 'github', 'deleted', { repo_name: fullName, sha: repo.latest_commit_sha });
          } catch (insertErr) {
            console.error(`[${now()}] Failed to insert deletion event for ${fullName}: ${insertErr.message}`);
          }
        }
        return { status: 'deleted', http_status: 404, response_time_ms: 0, error_message: null, details: null };
      }
    }
    return { status: 'error', http_status: null, response_time_ms: 0, error_message: err.message };
  }
}

/** Checks a Twitter/X URL via GET and records status changes on transitions. */
async function checkTwitter(url, projectId) {
  const start = Date.now();
  if (!url) {
    return { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: 'No URL provided' };
  }

  let lastStatus = null;
  let lastHttpStatus = null;
  if (projectId) {
    const row = await db.prepare(
      "SELECT status, http_status FROM check_logs WHERE project_id = ? AND resource_type = 'twitter' ORDER BY checked_at DESC LIMIT 1"
    ).get(projectId);
    lastStatus = row?.status || null;
    lastHttpStatus = row?.http_status ?? null;
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
    let newStatus = res.ok ? 'ok' : 'error';
    let _defuddleDetails = null;

    // ponytail: defuddle parse to detect suspended accounts when HTTP 200
    if (res.ok && _defuddleAvailable !== false) {
      try {
        if (_defuddleAvailable === undefined) {
          execSync('defuddle --version', { stdio: 'pipe', timeout: 5000, windowsHide: true });
          _defuddleAvailable = true;
        }
        const defuddleOut = execSync(`defuddle parse "${url}" --md`, {
          stdio: 'pipe',
          timeout: 10000,
          encoding: 'utf8',
          windowsHide: true,
        });
        if (defuddleOut.includes('Account suspended')) {
          newStatus = 'disabled';
          _defuddleDetails = { suspended_detected: true, defuddle_output: defuddleOut };
        }
      } catch {
        // defuddle unavailable or failed — skip on all subsequent checks
        _defuddleAvailable = false;
      }
    }

    const changed = lastStatus !== null && newStatus !== lastStatus;
    const status = changed ? 'changed' : newStatus;

    if (changed && projectId) {
      recordStatusChange(projectId, 'twitter', 'changed', { bs: lastStatus, as: newStatus, bhs: lastHttpStatus, ahs: res.status });
    }

    // ponytail: only persist defuddle output on meaningful status (changed/disabled) to keep logs lean
    const finalDetails = (status === 'changed' || status === 'disabled') ? _defuddleDetails : null;

    return {
      status,
      http_status: res.status,
      response_time_ms,
      error_message: res.ok ? null : `HTTP ${res.status}`,
      details: finalDetails,
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
  logCheck,
  recordStatusChange,
};
