// Projects REST API
const express = require('express');
const db = require('../services/db');
const { fetchReposForOwner, fetchCommitHistory, fetchLatestTag } = require('../services/github');
const { checkWebsite, checkGithubRepo, checkTwitter, logCheck, recordStatusChange } = require('../services/checker');

const router = express.Router();
const now = () => new Date().toISOString();

// Parse a raw project row: expand JSON group cols back to flat names for API compatibility.
function parseProjectRow(row) {
  if (!row) return row;
  return {
    ...row,
    website_url:         row.website  ? JSON.parse(row.website).url  : null,
    website_content_check: row.website ? (JSON.parse(row.website).cc ?? 1) : 1,
    github_url:           row.github   ? JSON.parse(row.github).url  : null,
    twitter_url:          row.twitter   ? JSON.parse(row.twitter).url : null,
    twitter_enabled:      row.twitter_enabled,
    twitter_posts_check:  row.twitter   ? (JSON.parse(row.twitter).pc ?? 1) : 1,
    telegram_url:         row.telegram  ? JSON.parse(row.telegram).url : null,
    price_enabled:        row.token_enabled,
  };
}

// ponytail: shared helper — loads a project or sends 404 and returns null
async function loadProjectOr404(res, id, userId) {
  const project = await db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(id, userId);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
  return parseProjectRow(project);
}

// ponytail: shared unavailable result for when a resource URL is not configured
const UNAVAILABLE = (msg) => ({ status: 'unavailable', http_status: null, response_time_ms: 0, error_message: msg });

// GET /api/projects — list all projects
router.get('/', async (req, res) => {
  const rows = await db.prepare(`
    SELECT id, name, website, github, twitter, telegram,
           website_enabled, github_enabled, twitter_enabled, telegram_enabled,
           token, token_enabled, enabled,
           created_at, updated_at
    FROM projects
    WHERE user_id = ?
    ORDER BY id DESC
  `).all(req.userId);
  res.json(rows.map(parseProjectRow));
});

// GET /api/projects/:id — single project with repos + latest check_logs
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await loadProjectOr404(res, id, req.userId);
  if (!project) return;

  const repos = await db.prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY full_name').all(id);

  const latestLogs = await db.prepare(`
    SELECT * FROM check_logs
    WHERE project_id = ?
      AND id IN (
        SELECT MAX(id) FROM check_logs
        WHERE project_id = ?
        GROUP BY resource_type
      )
    ORDER BY resource_type
  `).all(id, id);

  res.json({ ...parseProjectRow(project), repos, latest_logs: latestLogs });
});

// Helper: store repo with commit history — upsert without ON CONFLICT
/** Upserts a repo row (insert or update by project_id + full_name). */
async function storeRepo(projectId, repoInfo, history = {}, latestTag = null) {
  const existing = await db.prepare('SELECT id FROM repos WHERE project_id = ? AND full_name = ?').get(projectId, repoInfo.full_name);
  const ts = now();
  const h = {
    first_commit_date: null,
    latest_commit_date: null,
    total_commits: 0,
    latest_commit_sha: null,
    latest_commit_message: null,
    ...history,
  };

  if (existing) {
    await db.prepare(`
      UPDATE repos SET
        repo_url = ?, description = ?, default_branch = ?,
        first_commit_date = ?, latest_commit_date = ?, total_commits = ?,
        latest_commit_sha = ?, latest_commit_message = ?, pushed_at = ?,
        stars_count = ?, language = ?, latest_tag = ?, updated_at = ?
      WHERE id = ?
    `).run(
      repoInfo.repo_url, repoInfo.description, repoInfo.default_branch ?? 'main',
      h.first_commit_date, h.latest_commit_date, h.total_commits,
      h.latest_commit_sha, h.latest_commit_message, repoInfo.pushed_at,
      repoInfo.stars_count ?? 0, repoInfo.language, latestTag, ts,
      existing.id
    );
  } else {
    await db.prepare(`
      INSERT INTO repos (
        project_id, full_name, repo_url, description, default_branch,
        first_commit_date, latest_commit_date, total_commits, latest_commit_sha,
        latest_commit_message, pushed_at, stars_count, language, latest_tag, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      repoInfo.full_name, repoInfo.repo_url, repoInfo.description, repoInfo.default_branch ?? 'main',
      h.first_commit_date, h.latest_commit_date, h.total_commits,
      h.latest_commit_sha, h.latest_commit_message, repoInfo.pushed_at,
      repoInfo.stars_count ?? 0, repoInfo.language, latestTag,
      'active', ts, ts
    );
  }
}

// POST /api/projects — create project
router.post('/', async (req, res) => {
  const { name, website_url, github_url, twitter_url, telegram_url,
          website_enabled, website_content_check, twitter_posts_check,
          token, enabled, price_enabled } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  // Default twitter_posts_check to 1 when caller didn't specify (mirrors website_content_check)
  const twitterPc = req.body && Object.prototype.hasOwnProperty.call(req.body, 'twitter_posts_check')
    ? (twitter_posts_check ? 1 : 0)
    : 1;

  // Serialize URL fields to JSON
  const websiteJson  = website_url  ? JSON.stringify({ url: website_url, cc: website_content_check ? 1 : 0 }) : null;
  const githubJson   = github_url   ? JSON.stringify({ url: github_url })  : null;
  const twitterJson  = twitter_url  ? JSON.stringify({ url: twitter_url, pc: twitterPc }) : null;
  const telegramJson = telegram_url  ? JSON.stringify({ url: telegram_url }) : null;

  // Prevent duplicate: same name + website_url for this user
  if (website_url) {
    const existing = await db.prepare(
      'SELECT id FROM projects WHERE name = ? AND website IS NOT NULL AND user_id = ?'
    ).get(name, req.userId);
    if (existing) {
      // Re-parse to get the URL for comparison
      const parsed = parseProjectRow(existing);
      if (parsed.website_url === website_url) return res.status(409).json({ error: 'Project with this name and website already exists' });
    }
  }

  const ts = now();
  const tokenJson = (token && (token.symbol || token.contract || token.chain)) ? JSON.stringify(token) : null;
  const result = await db.prepare(`
    INSERT INTO projects (name, user_id, website, github, twitter, telegram,
      website_enabled, token, enabled, token_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, req.userId, websiteJson, githubJson, twitterJson, telegramJson,
    website_enabled ? 1 : 0, tokenJson, enabled === 0 ? 0 : 1, price_enabled ? 1 : 0, ts, ts);

  const projectId = result.lastInsertRowid;

  // Await checks and log results so Activity shows real status immediately (not "pending")
  const s = await db.config.getSettings(req.userId);
  if (s.checks_on_new_project) {
    try {
      if (website_url) {
        const r = await checkWebsite(website_url, projectId, !!website_content_check);
        await logCheck(projectId, 'website', null, r);
      }
      if (twitter_url) {
        const r = await checkTwitter(twitter_url, projectId, { postsCheck: !!twitterPc });
        await logCheck(projectId, 'twitter', null, r);
      }
    } catch (err) {
      console.error(`[${now()}] post-create checks failed for project ${projectId}: ${err.message}`);
    }
  }
  // github repos are added separately via add-repos; skip here

  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const repos = await db.prepare('SELECT * FROM repos WHERE project_id = ?').all(projectId);
  res.status(201).json({ ...parseProjectRow(project), repos });
});

// PUT /api/projects/:id — update project (optionally sync repos array)
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const allowed = ['name', 'website_url', 'github_url', 'twitter_url', 'telegram_url',
                   'website_enabled', 'website_content_check', 'github_enabled', 'twitter_enabled', 'telegram_enabled',
                   'twitter_posts_check',
                   'token', 'enabled', 'price_enabled'];
  const updates = {};
  for (const key of allowed) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      updates[key] = req.body[key];
    }
  }

  // Write adapter: serialize URL fields to JSON, rename price_enabled → token_enabled
  // Prune flat content/enabled flags that have been merged into JSON cols
  if ('website_url' in updates) {
    updates.website = updates.website_url
      ? JSON.stringify({ url: updates.website_url, cc: updates.website_content_check ? 1 : 0 })
      : null;
    delete updates.website_content_check;
    delete updates.website_url;
  } else if ('website_content_check' in updates) {
    // Only cc changing — patch cc in existing website JSON in-place
    const existingWebsite = existing?.website ? JSON.parse(existing.website) : {};
    existingWebsite.cc = updates.website_content_check ? 1 : 0;
    updates.website = JSON.stringify(existingWebsite);
    delete updates.website_content_check;
  }
  if ('github_url' in updates) {
    updates.github = updates.github_url ? JSON.stringify({ url: updates.github_url }) : null;
    delete updates.github_url;
  }
  if ('twitter_url' in updates) {
    // url changing — pc may also be in the same request, otherwise preserve existing
    const incomingPc = ('twitter_posts_check' in updates)
      ? (updates.twitter_posts_check ? 1 : 0)
      : (existing.twitter ? (JSON.parse(existing.twitter).pc ?? 1) : 1);
    updates.twitter = updates.twitter_url
      ? JSON.stringify({ url: updates.twitter_url, pc: incomingPc })
      : null;
    delete updates.twitter_url;
    delete updates.twitter_posts_check;
  } else if ('twitter_posts_check' in updates) {
    // only pc changing — patch in place to preserve url
    const tw = existing?.twitter ? JSON.parse(existing.twitter) : {};
    tw.pc = updates.twitter_posts_check ? 1 : 0;
    updates.twitter = JSON.stringify(tw);
    delete updates.twitter_posts_check;
  }
  if ('telegram_url' in updates) {
    updates.telegram = updates.telegram_url ? JSON.stringify({ url: updates.telegram_url }) : null;
    delete updates.telegram_url;
  }
  if ('price_enabled' in updates) {
    updates.token_enabled = updates.price_enabled;
    delete updates.price_enabled;
  }

  // Auto-fill token symbol/chain from DexScreener if contract is provided but symbol or chain is missing
  if (updates.token && updates.token.contract && (!updates.token.symbol || !updates.token.chain)) {
    try {
      const chain = updates.token.chain || 'solana';
      const data = await fetch(`https://api.dexscreener.com/token-pairs/v1/${chain}/${updates.token.contract}`).then(r => r.json());
      const pair = Array.isArray(data) ? data.find(p => p.baseToken?.address === updates.token.contract) : null;
      if (pair?.baseToken) {
        updates.token = {
          ...updates.token,
          symbol: updates.token.symbol || pair.baseToken.symbol || null,
          chain: updates.token.chain || pair.chainId || chain,
          contract: updates.token.contract,
        };
      }
    } catch (err) {
      console.error(`[${now()}] Dexscreener lookup failed: ${err.message}`);
    }
  }

  // Serialize token as JSON string for DB
  if (updates.token && typeof updates.token === 'object') {
    updates.token = (updates.token.symbol || updates.token.contract || updates.token.chain) ? JSON.stringify(updates.token) : null;
  }

  if (Object.keys(updates).length > 0) {
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(now(), id);
    await db.prepare(`UPDATE projects SET ${setClause}, updated_at = ? WHERE id = ?`).run(...values);
  }

  // Sync repos if provided: upsert each, delete any not in the list
  if (req.body && Array.isArray(req.body.repos)) {
    const submitted = new Set(req.body.repos.map(r => r.full_name));
    // Delete orphans
    if (submitted.size > 0) {
      const placeholders = Array(submitted.size).fill('?').join(',');
      await db.prepare(`DELETE FROM repos WHERE project_id = ? AND full_name NOT IN (${placeholders})`).run(id, ...req.body.repos.map(r => r.full_name));
    } else {
      await db.prepare('DELETE FROM repos WHERE project_id = ?').run(id);
    }
    // Upsert each submitted repo
    for (const repo of req.body.repos) {
      await storeRepo(id, repo, {}, null);
    }
  }

  const updated = await db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const repos = await db.prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY full_name').all(id);
  res.json({ ...parseProjectRow(updated), repos });
});

// DELETE /api/projects/:id — delete project (cascades)
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  await db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  res.json({ ok: true, deleted: id });
});

// GET /api/projects/:id/org-repos — fetch all repos from the org (for RepoManager)
router.get('/:id/org-repos', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await loadProjectOr404(res, id, req.userId);
  if (!project) return;
  if (!project.enabled) return res.status(400).json({ error: 'Project is disabled' });
  if (!project.github_url) return res.status(400).json({ error: 'No github_url' });
  try {
    const repos = await fetchReposForOwner(project.github_url);
    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/refresh-repos — re-fetch all repos from GitHub
router.post('/:id/refresh-repos', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await loadProjectOr404(res, id, req.userId);
  if (!project) return;
  if (!project.enabled) return res.status(400).json({ error: 'Project is disabled' });
  if (!project.github_url) return res.status(400).json({ error: 'Project has no github_url' });

  try {
    const githubRepos = await fetchReposForOwner(project.github_url);
    const githubFullNames = new Set(githubRepos.map(r => r.full_name));

    // Detect deleted repos
    const localActiveRepos = await db.prepare(
      'SELECT id, full_name, latest_commit_sha FROM repos WHERE project_id = ? AND status = \'active\''
    ).all(id);
    for (const localRepo of localActiveRepos) {
      if (!githubFullNames.has(localRepo.full_name)) {
        const ts = now();
        await db.prepare("UPDATE repos SET status = 'deleted', updated_at = ? WHERE id = ?").run(ts, localRepo.id);
        recordStatusChange(id, 'github', 'deleted', { full_name: localRepo.full_name, sha: localRepo.latest_commit_sha });
        await logCheck(id, 'github', localRepo.id, { status: 'deleted', http_status: 404, response_time_ms: 0, error_message: null, details: null });
      }
    }

    let updated = 0;
    let added = 0;
    for (const repoInfo of githubRepos) {
      const exists = await db.prepare('SELECT id FROM repos WHERE project_id = ? AND full_name = ?').get(id, repoInfo.full_name);
      try {
        const history = await fetchCommitHistory(repoInfo.full_name);
        const latestTag = await fetchLatestTag(repoInfo.full_name);
        await storeRepo(id, repoInfo, history, latestTag);
        if (exists) updated++; else added++;
      } catch (err) {
        console.error(`[${now()}] refresh-repos: commit history failed for ${repoInfo.full_name}: ${err.message}`);
        const latestTag = await fetchLatestTag(repoInfo.full_name).catch(() => null);
        await storeRepo(id, repoInfo, {
          first_commit_date: null, latest_commit_date: null, latest_commit_sha: null,
          latest_commit_message: null, total_commits: 0
        }, latestTag);
        if (exists) updated++; else added++;
      }
    }
    res.json({ ok: true, fetched: githubRepos.length, updated, added });
  } catch (err) {
    console.error(`[${now()}] refresh-repos failed for project ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/add-repos — upsert selected repos (fetched from GitHub)
router.post('/:id/add-repos', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await loadProjectOr404(res, id, req.userId);
  if (!project) return;
  if (!project.enabled) return res.status(400).json({ error: 'Project is disabled' });

  if (!req.body || !Array.isArray(req.body.repos)) {
    return res.status(400).json({ error: 'repos array required' });
  }

  const s = await db.config.getSettings(req.userId);
  for (const repo of req.body.repos) {
    await storeRepo(id, repo);
    if (s.checks_on_new_project) {
      try {
        const r = await checkGithubRepo(repo.full_name, id);
        await logCheck(id, 'github', null, r);
      } catch (err) {
        console.error(`[${now()}] initial github check failed for ${repo.full_name}: ${err.message}`);
      }
    }
  }

  const repos = await db.prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY full_name').all(id);
  res.json({ ok: true, repos });
});

// DELETE /api/projects/:id/repos/:full_name — hard-delete a specific repo
// Uses wildcard to handle full_names like "owner/repo" that contain slashes
router.delete('/:id/repos/*', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fullName = decodeURIComponent(req.params[0]);
  // Verify project belongs to user before deleting repo
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const existing = await db.prepare('SELECT id FROM repos WHERE project_id = ? AND full_name = ?').get(id, fullName);
  if (!existing) return res.status(404).json({ error: 'Repo not found' });
  await db.prepare('DELETE FROM repos WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

// POST /api/projects/:id/check-website
router.post('/:id/check-website', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await loadProjectOr404(res, id, req.userId);
  if (!project) return;
  if (!project.enabled) return res.status(400).json({ error: 'Project is disabled' });
  if (!project.website_url) {
    const result = UNAVAILABLE('No URL');
    await logCheck(id, 'website', null, result);
    return res.json(result);
  }
  const result = await checkWebsite(project.website_url, id, !!project.website_content_check);
  await logCheck(id, 'website', null, result);
  res.json(result);
});


// POST /api/projects/:id/check-github
router.post('/:id/check-github', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await loadProjectOr404(res, id, req.userId);
  if (!project) return;
  if (!project.enabled) return res.status(400).json({ error: 'Project is disabled' });
  if (!project.github_url) return res.status(400).json({ error: 'No github_url' });
  const repos = await db.prepare("SELECT * FROM repos WHERE project_id = ? AND status = 'active'").all(id);
  const results = [];
  for (const repo of repos) {
    const result = await checkGithubRepo(repo.full_name, id);
    await logCheck(id, 'github', repo.id, result);
    results.push({ repo: repo.full_name, ...result });
  }
  res.json({ ok: true, results });
});

// POST /api/projects/:id/check-twitter
router.post('/:id/check-twitter', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await loadProjectOr404(res, id, req.userId);
  if (!project) return;
  if (!project.enabled) return res.status(400).json({ error: 'Project is disabled' });
  if (!project.twitter_url) {
    const result = UNAVAILABLE('No URL');
    await logCheck(id, 'twitter', null, result);
    return res.json(result);
  }
  const result = await checkTwitter(project.twitter_url, id, { postsCheck: !!project.twitter_posts_check });
  await logCheck(id, 'twitter', null, result);
  res.json(result);
});

// GET /api/projects/:id/twitter-posts — list the latest stored posts for a project
router.get('/:id/twitter-posts', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await loadProjectOr404(res, id, req.userId);
  if (!project) return;
  const posts = await db.prepare(
    'SELECT id, post_id, author, link, content, published_at, created_at FROM twitter_posts WHERE project_id = ? ORDER BY published_at DESC, id DESC LIMIT 100'
  ).all(id);
  res.json(posts);
});


module.exports = router;
