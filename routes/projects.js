// Projects REST API
const express = require('express');
const db = require('../services/db');
const { fetchReposForOwner, fetchCommitHistory, fetchLatestTag } = require('../services/github');
const { checkWebsite, checkGithubRepo, checkTwitter, logCheck, recordStatusChange } = require('../services/checker');

const router = express.Router();
const now = () => new Date().toISOString();

// GET /api/projects — list all projects
router.get('/', async (req, res) => {
  const projects = await db.prepare(`
    SELECT id, name, website_url, github_url, twitter_url, telegram_url,
           website_enabled, website_content_check, github_enabled, twitter_enabled, telegram_enabled,
           created_at, updated_at
    FROM projects
    ORDER BY id DESC
  `).all();
  res.json(projects);
});

// GET /api/projects/:id — single project with repos + latest check_logs
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const repos = await db.prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY repo_name').all(id);

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

  res.json({ ...project, repos, latest_logs: latestLogs });
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
        repo_name = ?, repo_url = ?, description = ?, default_branch = ?,
        first_commit_date = ?, latest_commit_date = ?, total_commits = ?,
        latest_commit_sha = ?, latest_commit_message = ?, pushed_at = ?,
        stars_count = ?, language = ?, latest_tag = ?, updated_at = ?
      WHERE id = ?
    `).run(
      repoInfo.repo_name, repoInfo.repo_url, repoInfo.description, repoInfo.default_branch,
      h.first_commit_date, h.latest_commit_date, h.total_commits,
      h.latest_commit_sha, h.latest_commit_message, repoInfo.pushed_at,
      repoInfo.stars_count, repoInfo.language, latestTag, ts,
      existing.id
    );
  } else {
    await db.prepare(`
      INSERT INTO repos (
        project_id, repo_name, full_name, repo_url, description, default_branch,
        first_commit_date, latest_commit_date, total_commits, latest_commit_sha,
        latest_commit_message, pushed_at, stars_count, language, latest_tag, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      repoInfo.repo_name, repoInfo.full_name, repoInfo.repo_url, repoInfo.description, repoInfo.default_branch,
      h.first_commit_date, h.latest_commit_date, h.total_commits,
      h.latest_commit_sha, h.latest_commit_message, repoInfo.pushed_at,
      repoInfo.stars_count, repoInfo.language, latestTag,
      ts, ts
    );
  }
}

// POST /api/projects — create project
router.post('/', async (req, res) => {
  const { name, website_url, github_url, twitter_url, telegram_url,
          website_enabled, website_content_check } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const ts = now();
  const result = await db.prepare(`
    INSERT INTO projects (name, website_url, github_url, twitter_url, telegram_url,
      website_enabled, website_content_check, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, website_url || null, github_url || null, twitter_url || null, telegram_url || null,
    website_enabled ? 1 : 0, website_content_check ? 1 : 0, ts, ts);

  const projectId = result.lastInsertRowid;

  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const repos = await db.prepare('SELECT * FROM repos WHERE project_id = ?').all(projectId);
  res.status(201).json({ ...project, repos });
});

// PUT /api/projects/:id — update project (optionally sync repos array)
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const allowed = ['name', 'website_url', 'github_url', 'twitter_url', 'telegram_url',
                   'website_enabled', 'website_content_check', 'github_enabled', 'twitter_enabled', 'telegram_enabled'];
  const updates = {};
  for (const key of allowed) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      updates[key] = req.body[key];
    }
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
      const exists = await db.prepare('SELECT id FROM repos WHERE project_id = ? AND full_name = ?').get(id, repo.full_name);
      const ts = now();
      if (exists) {
        await db.prepare(`
          UPDATE repos SET repo_name=?, repo_url=?, description=?, default_branch=?,
            stars_count=?, language=?, status='active', updated_at=?
          WHERE id = ?
        `).run(repo.repo_name, repo.repo_url, repo.description, repo.default_branch,
          repo.stars_count, repo.language, ts, exists.id);
      } else {
        await db.prepare(`
          INSERT INTO repos (project_id, repo_name, full_name, repo_url, description, default_branch,
            stars_count, language, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(id, repo.repo_name, repo.full_name, repo.repo_url, repo.description, repo.default_branch,
          repo.stars_count, repo.language, ts, ts);
      }
    }
  }

  const updated = await db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const repos = await db.prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY repo_name').all(id);
  res.json({ ...updated, repos });
});

// DELETE /api/projects/:id — delete project (cascades)
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  await db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  res.json({ ok: true, deleted: id });
});

// GET /api/projects/:id/org-repos — fetch all repos from the org (for RepoManager)
router.get('/:id/org-repos', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
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
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
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
        recordStatusChange(id, 'github', 'deleted', { repo_name: localRepo.full_name, sha: localRepo.latest_commit_sha });
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
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (!req.body || !Array.isArray(req.body.repos)) {
    return res.status(400).json({ error: 'repos array required' });
  }

  for (const repo of req.body.repos) {
    await storeRepo(id, repo);
  }

  const repos = await db.prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY repo_name').all(id);
  res.json({ ok: true, repos });
});

// DELETE /api/projects/:id/repos/:full_name — hard-delete a specific repo
// Uses wildcard to handle full_names like "owner/repo" that contain slashes
router.delete('/:id/repos/*', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fullName = decodeURIComponent(req.params[0]);
  const existing = await db.prepare('SELECT id FROM repos WHERE project_id = ? AND full_name = ?').get(id, fullName);
  if (!existing) return res.status(404).json({ error: 'Repo not found' });
  await db.prepare('DELETE FROM repos WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

// POST /api/projects/:id/check-website
router.post('/:id/check-website', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.website_url) {
    const result = { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: 'No URL' };
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
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
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
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.twitter_url) {
    const result = { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: 'No URL' };
    await logCheck(id, 'twitter', null, result);
    return res.json(result);
  }
  const result = await checkTwitter(project.twitter_url, id);
  await logCheck(id, 'twitter', null, result);
  res.json(result);
});


module.exports = router;
