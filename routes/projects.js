// Projects REST API
const express = require('express');
const db = require('../db');
const { fetchReposForOwner, fetchCommitHistory } = require('../services/github');
const { checkWebsite, checkGithubRepo, checkTwitter, logCheck } = require('../services/checker');

const router = express.Router();
const now = () => new Date().toISOString();

// GET /api/projects — list all projects
router.get('/', (req, res) => {
  const projects = db.prepare(`
    SELECT id, name, website_url, github_url, twitter_url, telegram_url,
           website_enabled, github_enabled, twitter_enabled, telegram_enabled,
           created_at, updated_at
    FROM projects
    ORDER BY id DESC
  `).all();
  res.json(projects);
});

// GET /api/projects/:id — single project with repos + latest check_logs
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const repos = db.prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY repo_name').all(id);

  // Latest check log per resource_type
  const latestLogs = db.prepare(`
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
async function storeRepo(projectId, repoInfo, history) {
  const existing = db.prepare('SELECT id FROM repos WHERE project_id = ? AND full_name = ?').get(projectId, repoInfo.full_name);
  const ts = now();

  if (existing) {
    db.prepare(`
      UPDATE repos SET
        repo_name = ?, repo_url = ?, description = ?, default_branch = ?,
        first_commit_date = ?, latest_commit_date = ?, total_commits = ?,
        latest_commit_sha = ?, latest_commit_message = ?, pushed_at = ?,
        stars_count = ?, language = ?, updated_at = ?
      WHERE id = ?
    `).run(
      repoInfo.repo_name, repoInfo.repo_url, repoInfo.description, repoInfo.default_branch,
      history.first_commit_date, history.latest_commit_date, history.total_commits,
      history.latest_commit_sha, history.latest_commit_message, repoInfo.pushed_at,
      repoInfo.stars_count, repoInfo.language, ts,
      existing.id
    );
  } else {
    db.prepare(`
      INSERT INTO repos (
        project_id, repo_name, full_name, repo_url, description, default_branch,
        first_commit_date, latest_commit_date, total_commits, latest_commit_sha,
        latest_commit_message, pushed_at, stars_count, language, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      repoInfo.repo_name, repoInfo.full_name, repoInfo.repo_url, repoInfo.description, repoInfo.default_branch,
      history.first_commit_date, history.latest_commit_date, history.total_commits,
      history.latest_commit_sha, history.latest_commit_message, repoInfo.pushed_at,
      repoInfo.stars_count, repoInfo.language,
      ts, ts
    );
  }
}

// POST /api/projects — create project
router.post('/', async (req, res) => {
  const { name, website_url, github_url, twitter_url, telegram_url } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const ts = now();
  const result = db.prepare(`
    INSERT INTO projects (name, website_url, github_url, twitter_url, telegram_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, website_url || null, github_url || null, twitter_url || null, telegram_url || null, ts, ts);

  const projectId = result.lastInsertRowid;

  // Fetch GitHub repos if github_url provided
  if (github_url) {
    try {
      console.log(`[${now()}] Fetching repos for project ${projectId} from ${github_url}`);
      const repos = await fetchReposForOwner(github_url);
      for (const repoInfo of repos) {
        try {
          const history = await fetchCommitHistory(repoInfo.full_name);
          await storeRepo(projectId, repoInfo, history);
        } catch (err) {
          console.error(`[${now()}] Failed to fetch commit history for ${repoInfo.full_name}: ${err.message}`);
          // Store repo with empty commit history
          await storeRepo(projectId, repoInfo, {
            first_commit_date: null, latest_commit_date: null, latest_commit_sha: null,
            latest_commit_message: null, total_commits: 0
          });
        }
      }
    } catch (err) {
      console.error(`[${now()}] GitHub fetch failed for project ${projectId}: ${err.message}`);
    }
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const repos = db.prepare('SELECT * FROM repos WHERE project_id = ?').all(projectId);
  res.status(201).json({ ...project, repos });
});

// PUT /api/projects/:id — update project
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const allowed = ['name', 'website_url', 'github_url', 'twitter_url', 'telegram_url',
                   'website_enabled', 'github_enabled', 'twitter_enabled', 'telegram_enabled'];
  const updates = {};
  for (const key of allowed) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      updates[key] = req.body[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.json(existing);
  }

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(now(), id);

  db.prepare(`UPDATE projects SET ${setClause}, updated_at = ? WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  res.json(updated);
});

// DELETE /api/projects/:id — delete project (cascades)
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  res.json({ ok: true, deleted: id });
});

// POST /api/projects/:id/refresh-repos — re-fetch all repos from GitHub
router.post('/:id/refresh-repos', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.github_url) return res.status(400).json({ error: 'Project has no github_url' });

  try {
    const repos = await fetchReposForOwner(project.github_url);
    let updated = 0;
    let added = 0;
    for (const repoInfo of repos) {
      const exists = db.prepare('SELECT id FROM repos WHERE project_id = ? AND full_name = ?').get(id, repoInfo.full_name);
      try {
        const history = await fetchCommitHistory(repoInfo.full_name);
        await storeRepo(id, repoInfo, history);
        if (exists) updated++; else added++;
      } catch (err) {
        console.error(`[${now()}] refresh-repos: commit history failed for ${repoInfo.full_name}: ${err.message}`);
        await storeRepo(id, repoInfo, {
          first_commit_date: null, latest_commit_date: null, latest_commit_sha: null,
          latest_commit_message: null, total_commits: 0
        });
        if (exists) updated++; else added++;
      }
    }
    res.json({ ok: true, fetched: repos.length, updated, added });
  } catch (err) {
    console.error(`[${now()}] refresh-repos failed for project ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/check-website
router.post('/:id/check-website', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.website_enabled) {
    const result = { status: 'disabled', http_status: null, response_time_ms: 0, error_message: null };
    logCheck(id, 'website', null, result);
    return res.json(result);
  }
  if (!project.website_url) {
    const result = { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: 'No URL' };
    logCheck(id, 'website', null, result);
    return res.json(result);
  }
  const result = await checkWebsite(project.website_url);
  logCheck(id, 'website', null, result);
  res.json(result);
});

// POST /api/projects/:id/check-github
router.post('/:id/check-github', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.github_enabled) {
    const result = { status: 'disabled', http_status: null, response_time_ms: 0, error_message: null };
    logCheck(id, 'github', null, result);
    return res.json(result);
  }
  const repos = db.prepare('SELECT * FROM repos WHERE project_id = ?').all(id);
  const results = [];
  for (const repo of repos) {
    const result = await checkGithubRepo(repo.full_name, id);
    logCheck(id, 'github', repo.full_name, result);
    results.push({ repo: repo.full_name, ...result });
  }
  res.json({ ok: true, results });
});

// POST /api/projects/:id/check-twitter
router.post('/:id/check-twitter', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.twitter_enabled) {
    const result = { status: 'disabled', http_status: null, response_time_ms: 0, error_message: null };
    logCheck(id, 'twitter', null, result);
    return res.json(result);
  }
  if (!project.twitter_url) {
    const result = { status: 'unavailable', http_status: null, response_time_ms: 0, error_message: 'No URL' };
    logCheck(id, 'twitter', null, result);
    return res.json(result);
  }
  const result = await checkTwitter(project.twitter_url);
  logCheck(id, 'twitter', null, result);
  res.json(result);
});

module.exports = router;