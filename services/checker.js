// Health-check services: website, github, twitter
const db = require('./db');
const { proxyFetch } = require('./proxy-fetch');
const { createHash } = require('crypto');
const { execSync } = require('child_process');
const { JSDOM } = require('jsdom');
// ponytail: rss-parser uses Node's legacy https.get which nitter.net accepts;
// built-in fetch / node-fetch-native both return empty bodies from nitter.
const RssParser = require('rss-parser');
const rssParser = new RssParser();
// ponytail: cached defuddle availability, checked once on first Twitter check
let _defuddleAvailable = undefined;
// ponytail: set to false before calling checkTwitter to skip defuddle suspended-account check
let enableDefuddleSuspendedCheck = true;

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

// ponytail: shared helpers, extracted to avoid duplication between checkWebsite and checkTwitter
function emptyUrlResult(msg) {
  return { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: msg };
}

async function fetchWithTimeout(url, ms, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  const t0 = Date.now();
  try {
    const res = await proxyFetch(url, { signal: controller.signal, redirect: 'follow', ...opts });
    return { res, responseTimeMs: Date.now() - t0 };
  } finally {
    clearTimeout(timeout);
  }
}

// Check a website URL: GET + optional MD5 hash of body.
/** Checks a website via GET, optionally hashing body to detect content changes. */
async function checkWebsite(url, projectId, contentCheck = true) {
  const start = Date.now();
  if (!url) return emptyUrlResult('No URL provided');

  let lastHash = null;
  let lastHttpStatus = null;
  if (contentCheck && projectId) {
    // lastHash: most recent row's content_hash; COALESCE handles the case where the
    // most recent row is 'changed' (transitional) — we still want its hash as baseline
    // so we don't re-fire the same event on the next check. Fallback to previous row
    // only if the most recent row has null details (e.g. error state with no hash).
    const hashRow = await db.prepare(
      "SELECT details FROM check_logs WHERE project_id = ? AND resource_type = 'website' ORDER BY checked_at DESC LIMIT 1"
    ).get(projectId);
    const prevHashRow = hashRow?.details == null ? await db.prepare(
      "SELECT details FROM check_logs WHERE project_id = ? AND resource_type = 'website' AND details IS NOT NULL ORDER BY checked_at DESC LIMIT 1"
    ).get(projectId) : null;
    const targetHashRow = hashRow?.details != null ? hashRow : prevHashRow;
    if (targetHashRow?.details) {
      try { lastHash = JSON.parse(targetHashRow.details).content_hash || null; } catch (_) {}
    }
    // lastHttpStatus: most recent steady-state row (skip transitional 'changed' rows)
    const statusRow = await db.prepare(
      "SELECT http_status FROM check_logs WHERE project_id = ? AND resource_type = 'website' AND status != 'changed' ORDER BY checked_at DESC LIMIT 1"
    ).get(projectId);
    lastHttpStatus = statusRow?.http_status ?? null;
  }

  try {
    const { res, responseTimeMs } = await fetchWithTimeout(url, 15000, {
      method: 'GET',
      headers: { 'User-Agent': 'project-checker/1.0' }
    });
    const response_time_ms = responseTimeMs;

    let contentHash = null;
    if (contentCheck && res.ok) {
      try {
        const bodyText = await res.text();
        const stableMeta = extractStableMeta(bodyText);
        contentHash = createHash('md5').update(stableMeta).digest('hex');
      } catch (_) {}
    }

    let status;
    let _contentChangedEvent = false; // ponytail: true when content-change triggered the event, skips dup HTTP status event
    if (contentCheck) {
      const changed = lastHash && contentHash && lastHash !== contentHash;
      status = res.ok ? (changed ? 'changed' : 'ok') : 'error';
      if (changed && projectId) {
        _contentChangedEvent = true;
        recordStatusChange(projectId, 'website', 'changed', { bh: lastHash, ah: contentHash, bhs: lastHttpStatus, ahs: res.status });
      }
    } else {
      status = res.ok ? 'ok' : 'error';
    }

    // Record HTTP status changes (e.g. 200 → 404 or 200 → 500) as events, skip if content-change already fired.
    // Also record when lastHttpStatus is null (first check or prior error) and current result is non-ok — so
    // a brand-new project that starts with a failure still gets an event logged.
    const statusNonOk = !res.ok || status === 'error' || status === 'unavailable';
    if (lastHttpStatus !== null
      ? (lastHttpStatus !== res.status && projectId && !_contentChangedEvent)
      : (statusNonOk && projectId && !_contentChangedEvent)) {
      const eventType = res.status === 404 ? 'deleted' : 'changed';
      recordStatusChange(projectId, 'website', eventType, { bhs: lastHttpStatus, ahs: res.status });
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
        recordStatusChange(projectId, 'github', 'tag_changed', { full_name: fullName, ot: repo.latest_tag, nt: latestTag });
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
        recordStatusChange(projectId, 'github', 'changed', { full_name: fullName, sha: history.latest_commit_sha });
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
            recordStatusChange(projectId, 'github', 'deleted', { full_name: fullName, sha: repo.latest_commit_sha });
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

/** Extracts a Twitter handle (e.g. "anthropicai") from a full URL.
    Accepts https://twitter.com/handle, https://x.com/handle, with or without www. */
function handleFromTwitterUrl(url) {
  return String(url || '')
    .replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//, '')
    .replace(/^\/+/, '')
    .replace(/\/.*$/, '')
    .trim();
}

// ponytail: how many posts to seed on first run (nitter RSS is newest-first, so cap = oldest of seeded baseline)
const FIRST_RUN_POST_LIMIT = 20;

async function fetchAndStoreTwitterPosts(projectId, handle) {
  if (!projectId || !handle) return { newPosts: 0, newPostIds: [] };
  const rssUrl = `https://nitter.net/${encodeURIComponent(handle)}/rss`;

  // ponytail: retry failed RSS fetches up to 3 times with a delay between attempts; only log after all retries exhaust
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  let feed;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await proxyFetch(rssUrl);
      feed = await rssParser.parseString(text);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
  if (lastErr) {
    // ponytail: last resort — try direct without proxy using Node's https (HTTP/1.1)
    try {
      const text = await new Promise((resolve, reject) => {
        const u = new URL(rssUrl);
        require('https').get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; project-checker/1.0)' } }, res => {
          if (!res.statusCode || res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode ?? 0}`));
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve(body));
        }).on('error', reject).setTimeout(15000, () => reject(new Error('timeout')));
      });
      feed = await rssParser.parseString(text);
      lastErr = null;
    } catch (directErr) {
      console.error(`[${now()}] rss-parser failed for ${rssUrl} after ${MAX_RETRIES} proxy attempts and direct fallback: ${directErr.message}`);
      return { newPosts: 0, newPostIds: [] };
    }
  }
  const items = Array.isArray(feed?.items) ? feed.items : [];
  if (!items.length) return { newPosts: 0, newPostIds: [] };

  // Pre-fetch existing post_ids so we can compute the diff (the db proxy doesn't expose run.changes)
  const existing = await db.prepare(
    'SELECT post_id FROM twitter_posts WHERE project_id = ?'
  ).all(projectId);
  const isFirstRun = existing.length === 0;
  const seen = new Set(existing.map(r => r.post_id));

  const insert = db.prepare(`
    INSERT OR IGNORE INTO twitter_posts (project_id, post_id, author, link, content, published_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const newPostIds = [];
  let seeded = 0;
  for (const item of items) {
    const postId = String(item?.guid ?? item?.id ?? item?.link ?? '').trim();
    if (!postId || seen.has(postId)) continue;
    // ponytail: on first run cap at FIRST_RUN_POST_LIMIT to avoid seeding months of history
    if (isFirstRun && seeded >= FIRST_RUN_POST_LIMIT) break;
    seen.add(postId);
    await insert.run(
      projectId,
      postId,
      String(item?.creator ?? item?.author ?? '').trim() || null,
      String(item?.link ?? '').trim() || null,
      String(item?.contentSnippet ?? item?.content ?? '').trim() || null,
      item?.isoDate ?? item?.pubDate ?? null
    );
    newPostIds.push(postId);
    seeded++;
  }

  // ponytail: on first run seed the table silently — only fire event for genuinely new subsequent posts
  if (isFirstRun) return { newPosts: 0, newPostIds: [] };

  return { newPosts: newPostIds.length, newPostIds };
}

/** Checks a Twitter/X URL via GET and records status changes on transitions. */
async function checkTwitter(url, projectId, opts = {}) {
  const start = Date.now();
  if (!url) return { ...emptyUrlResult('No URL provided'), details: null };

  const { postsCheck = false } = opts;
  const handle = opts.handle || handleFromTwitterUrl(url);

  let lastStatus = null;
  let lastHttpStatus = null;
  if (projectId) {
    // lastStatus: most recent steady-state row (skip transitional 'changed' rows)
    const statusRow = await db.prepare(
      "SELECT status FROM check_logs WHERE project_id = ? AND resource_type = 'twitter' AND status != 'changed' ORDER BY checked_at DESC LIMIT 1"
    ).get(projectId);
    lastStatus = statusRow?.status || null;
    // lastHttpStatus: most recent steady-state row (skip transitional 'changed' rows)
    const httpRow = await db.prepare(
      "SELECT http_status FROM check_logs WHERE project_id = ? AND resource_type = 'twitter' AND status != 'changed' ORDER BY checked_at DESC LIMIT 1"
    ).get(projectId);
    lastHttpStatus = httpRow?.http_status ?? null;
  }

  try {
    const { res, responseTimeMs } = await fetchWithTimeout(url, 15000, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; project-checker/1.0)' }
    });
    const response_time_ms = responseTimeMs;
    let newStatus = res.ok ? 'ok' : 'error';
    let _defuddleDetails = null;

    // ponytail: defuddle parse to detect suspended accounts when HTTP 200
    if (res.ok && _defuddleAvailable !== false && enableDefuddleSuspendedCheck) {
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

    // ponytail: when posts check is on and the account responded OK, fetch RSS and dedup into twitter_posts
    let _postsResult = null;
    let _postsChangedEvent = false; // ponytail: true when posts triggered the changed-status, skips duplicate transition event
    if (res.ok && postsCheck && handle) {
      try {
        _postsResult = await fetchAndStoreTwitterPosts(projectId, handle);
        if (_postsResult.newPosts > 0) {
          newStatus = 'changed';
          _postsChangedEvent = true;
          recordStatusChange(projectId, 'twitter', 'changed', {
            new_posts: _postsResult.newPosts,
            post_ids: _postsResult.newPostIds,
          });
        }
      } catch (err) {
        console.error(`[${now()}] fetchAndStoreTwitterPosts failed for project ${projectId}: ${err.message}`);
      }
    }

    // ponytail: skip if posts branch already recorded the changed event (avoids dup on new posts)
    const changed = !_postsChangedEvent && lastStatus !== null && newStatus !== lastStatus;

    if (changed && projectId) {
      recordStatusChange(projectId, 'twitter', 'changed', { bs: lastStatus, as: newStatus, bhs: lastHttpStatus, ahs: res.status });
    }

    // ponytail: skip if posts branch already recorded the changed event (avoids dup on new posts)
    if (lastHttpStatus !== null && lastHttpStatus !== res.status && projectId && !_postsChangedEvent) {
      const eventType = res.status === 404 ? 'deleted' : 'changed';
      recordStatusChange(projectId, 'twitter', eventType, { bhs: lastHttpStatus, ahs: res.status });
    }

    // ponytail: only persist defuddle output on meaningful status (disabled) to keep logs lean
    let finalDetails = newStatus === 'disabled' ? _defuddleDetails : null;
    if (_postsResult && _postsResult.newPosts > 0) {
      finalDetails = { new_posts: _postsResult.newPosts, post_ids: _postsResult.newPostIds };
    }

    return {
      status: newStatus,
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
  fetchAndStoreTwitterPosts,
  handleFromTwitterUrl,
  get enableDefuddleSuspendedCheck() { return enableDefuddleSuspendedCheck; },
  set enableDefuddleSuspendedCheck(v) { enableDefuddleSuspendedCheck = v; },
};
