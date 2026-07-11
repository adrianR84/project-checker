// Dashboard REST API — aggregated view
const express = require('express');
const db = require('../services/db');

const router = express.Router();

// GET /api/dashboard
router.get('/', async (req, res) => {
  const projects = await db.prepare(`
    SELECT id, name, enabled, token, price_enabled,
           website_enabled, website_content_check, github_enabled, twitter_enabled, telegram_enabled,
           website_url, github_url, twitter_url, telegram_url,
           created_at, updated_at
    FROM projects
    WHERE enabled = 1 AND user_id = ?
    ORDER BY id
  `).all(req.userId);

  const result = [];
  for (const p of projects) {
    const websiteCheck = await db.prepare(`
      SELECT status, http_status, checked_at FROM check_logs
      WHERE project_id = ? AND resource_type = 'website'
      ORDER BY checked_at DESC, id DESC LIMIT 1
    `).get(p.id);

    const twitterCheck = await db.prepare(`
      SELECT status, http_status, checked_at FROM check_logs
      WHERE project_id = ? AND resource_type = 'twitter'
      ORDER BY checked_at DESC, id DESC LIMIT 1
    `).get(p.id);

    const githubCheck = await db.prepare(`
      SELECT cl.status, cl.checked_at FROM check_logs cl
      INNER JOIN repos r ON r.project_id = cl.project_id
      WHERE cl.project_id = ? AND cl.resource_type = 'github'
      ORDER BY cl.checked_at DESC, cl.id DESC LIMIT 1
    `).get(p.id);

    /** Returns { created_at, confirmed } of the latest event_log for a resource type. */
    const latestEvent = async (resourceType) => {
      const row = await db.prepare(
        "SELECT created_at, confirmed FROM event_logs WHERE project_id = ? AND resource_type = ? ORDER BY created_at DESC LIMIT 1"
      ).get(p.id, resourceType);
      return row || null;
    };

    const [websiteEvt, githubEvt, twitterEvt] = await Promise.all([
      latestEvent('website'),
      latestEvent('github'),
      latestEvent('twitter'),
    ]);

    const repos = await db.prepare(`
      SELECT repo_name, full_name, repo_url, latest_commit_date, latest_commit_message,
             latest_commit_sha, total_commits, stars_count, language, pushed_at, latest_tag
      FROM repos
      WHERE project_id = ? AND status = 'active'
      ORDER BY repo_name
    `).all(p.id);

    const deletedRepos = await db.prepare(`
      SELECT repo_name, full_name, latest_commit_sha, updated_at
      FROM repos
      WHERE project_id = ? AND status = 'deleted'
      ORDER BY repo_name
    `).all(p.id);

    result.push({
      id: p.id,
      name: p.name,
      enabled: !!p.enabled,
      token: p.token || null,
      price_enabled: !!p.price_enabled,
      website_enabled: !!p.website_enabled,
      website_content_check: !!p.website_content_check,
      github_enabled: !!p.github_enabled,
      twitter_enabled: !!p.twitter_enabled,
      telegram_enabled: !!p.telegram_enabled,
      website_url: p.website_url,
      github_url: p.github_url,
      twitter_url: p.twitter_url,
      telegram_url: p.telegram_url || null,
      created_at: p.created_at,
      updated_at: p.updated_at,
      website_status: websiteCheck || null,
      github_status:  githubCheck  || null,
      twitter_status: twitterCheck || null,
      website_last_changed_at: websiteEvt?.created_at || null,
      github_last_changed_at:  githubEvt?.created_at  || null,
      twitter_last_changed_at: twitterEvt?.created_at  || null,
      has_unconfirmed: !!(websiteEvt?.confirmed === 0 || githubEvt?.confirmed === 0 || twitterEvt?.confirmed === 0),
      repos,
      deletedRepos
    });
  }

  res.json(result);
});

// GET /api/dashboard/token-prices
router.get('/token-prices', async (req, res) => {
  const rows = await db.prepare(`
    SELECT tp.*, p.name AS project_name, p.github_url, p.twitter_url, p.website_url, p.price_enabled
    FROM token_prices tp
    JOIN projects p ON p.id = tp.project_id AND p.enabled = 1 AND p.user_id = ?
    ORDER BY p.name
  `).all(req.userId);
  res.json(rows);
});

module.exports = router;
