// Dashboard REST API — aggregated view
const express = require('express');
const db = require('../services/db');

const router = express.Router();

// GET /api/dashboard
router.get('/', (req, res) => {
  const projects = db.prepare(`
    SELECT id, name,
           website_enabled, github_enabled, twitter_enabled,
           website_url, github_url, twitter_url
    FROM projects
    ORDER BY id
  `).all();

  const result = projects.map(p => {
    // Latest website check
    const websiteCheck = db.prepare(`
      SELECT status, http_status, checked_at FROM check_logs
      WHERE project_id = ? AND resource_type = 'website'
      ORDER BY checked_at DESC, id DESC LIMIT 1
    `).get(p.id);

    // Latest twitter check
    const twitterCheck = db.prepare(`
      SELECT status, http_status, checked_at FROM check_logs
      WHERE project_id = ? AND resource_type = 'twitter'
      ORDER BY checked_at DESC, id DESC LIMIT 1
    `).get(p.id);

    // Latest github check (aggregate across all repos for this project)
    const githubCheck = db.prepare(`
      SELECT cl.status, cl.checked_at FROM check_logs cl
      INNER JOIN repos r ON r.project_id = cl.project_id
      WHERE cl.project_id = ? AND cl.resource_type = 'github'
      ORDER BY cl.checked_at DESC, cl.id DESC LIMIT 1
    `).get(p.id);

    // Per-repo data
    const repos = db.prepare(`
      SELECT repo_name, full_name, repo_url, latest_commit_date, latest_commit_message,
             latest_commit_sha, total_commits, stars_count, language, pushed_at
      FROM repos
      WHERE project_id = ?
      ORDER BY repo_name
    `).all(p.id);

    // Map: dashboard field name → frontend expected name
    // Frontend expects: website_status, github_status, twitter_status
    return {
      id: p.id,
      name: p.name,
      website_enabled: !!p.website_enabled,
      github_enabled: !!p.github_enabled,
      twitter_enabled: !!p.twitter_enabled,
      website_url: p.website_url,
      github_url: p.github_url,
      twitter_url: p.twitter_url,
      website_status: websiteCheck || null,
      github_status:  githubCheck  || null,
      twitter_status: twitterCheck || null,
      repos
    };
  });

  res.json(result);
});

module.exports = router;