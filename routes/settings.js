// Settings REST API (config singleton + trigger-all)
const express = require('express');
const db = require('../db');
const { checkWebsite, checkGithubRepo, checkTwitter, logCheck } = require('../services/checker');

const router = express.Router();
const now = () => new Date().toISOString();

// GET /api/settings
router.get('/', (req, res) => {
  const cfg = db.prepare('SELECT * FROM config WHERE id = 1').get();
  res.json(cfg);
});

// PUT /api/settings — update check intervals
router.put('/', (req, res) => {
  const allowed = ['commit_check_hours', 'website_check_hours', 'twitter_check_hours'];
  const updates = {};
  for (const key of allowed) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      const v = parseInt(req.body[key], 10);
      if (!Number.isFinite(v) || v < 1) {
        return res.status(400).json({ error: `${key} must be a positive integer` });
      }
      updates[key] = v;
    }
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE config SET ${setClause} WHERE id = 1`).run(...Object.values(updates));

  const cfg = db.prepare('SELECT * FROM config WHERE id = 1').get();
  console.log(`[${now()}] Settings updated: ${JSON.stringify(updates)}`);
  res.json(cfg);
});

// Run checks for a single project across enabled resources
async function runChecksForProject(project) {
  const results = { website: null, github: [], twitter: null };

  if (project.website_enabled && project.website_url) {
    const r = await checkWebsite(project.website_url);
    logCheck(project.id, 'website', null, r);
    results.website = r;
  }

  if (project.twitter_enabled && project.twitter_url) {
    const r = await checkTwitter(project.twitter_url);
    logCheck(project.id, 'twitter', null, r);
    results.twitter = r;
  }

  if (project.github_enabled) {
    const repos = db.prepare('SELECT * FROM repos WHERE project_id = ?').all(project.id);
    for (const repo of repos) {
      const r = await checkGithubRepo(repo.full_name, project.id);
      logCheck(project.id, 'github', repo.full_name, r);
      results.github.push({ repo: repo.full_name, ...r });
    }
  }

  return results;
}

// POST /api/settings/trigger-all
router.post('/trigger-all', async (req, res) => {
  const projects = db.prepare('SELECT * FROM projects').all();
  console.log(`[${now()}] Triggering all checks for ${projects.length} projects`);
  const allResults = [];
  for (const project of projects) {
    try {
      const r = await runChecksForProject(project);
      allResults.push({ project_id: project.id, name: project.name, results: r });
    } catch (err) {
      console.error(`[${now()}] trigger-all failed for project ${project.id}: ${err.message}`);
      allResults.push({ project_id: project.id, name: project.name, error: err.message });
    }
  }
  res.json({ ok: true, triggered: allResults.length, results: allResults });
});

// POST /api/settings/clear-data — empty all tables except config
router.post('/clear-data', (req, res) => {
  db.prepare('DELETE FROM check_logs').run();
  db.prepare('DELETE FROM repos').run();
  db.prepare('DELETE FROM projects').run();
  res.json({ ok: true });
});

module.exports = router;
module.exports.runChecksForProject = runChecksForProject;