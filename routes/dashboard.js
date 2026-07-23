// Dashboard REST API — aggregated view
const express = require('express');
const db = require('../services/db');

const router = express.Router();

// Parse a raw project row: expand JSON group cols back to flat names for API compatibility.
function parseProjectRow(row) {
  if (!row) return row;
  return {
    ...row,
    website_url:         row.website  ? JSON.parse(row.website).url  : null,
    website_content_check: row.website ? (JSON.parse(row.website).cc ?? 1) : 1,
    github_url:          row.github   ? JSON.parse(row.github).url  : null,
    twitter_url:         row.twitter   ? JSON.parse(row.twitter).url : null,
    twitter_enabled:     row.twitter_enabled,
    twitter_posts_check: row.twitter   ? (JSON.parse(row.twitter).pc ?? 1) : 1,
    telegram_url:        row.telegram  ? JSON.parse(row.telegram).url : null,
    price_enabled:       row.token_enabled,
  };
}

// GET /api/dashboard
router.get('/', async (req, res) => {
  const rows = await db.prepare(`
    SELECT id, name, enabled, activity_display, token, token_enabled,
           website, github, twitter, telegram,
           website_enabled, github_enabled, twitter_enabled, telegram_enabled,
           created_at, updated_at
    FROM projects
    WHERE enabled = 1 AND activity_display = 1 AND user_id = ?
    ORDER BY id
  `).all(req.userId);

  const result = [];
  for (const raw of rows) {
    const p = parseProjectRow(raw);
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
      SELECT full_name, repo_url, latest_commit_date, latest_commit_message,
             latest_commit_sha, total_commits, stars_count, language, pushed_at, latest_tag
      FROM repos
      WHERE project_id = ? AND status = 'active'
      ORDER BY full_name
    `).all(p.id);

    const deletedRepos = await db.prepare(`
      SELECT full_name, latest_commit_sha, updated_at
      FROM repos
      WHERE project_id = ? AND status = 'deleted'
      ORDER BY full_name
    `).all(p.id);

    result.push({
      id: p.id,
      name: p.name,
      enabled: !!p.enabled,
      activity_display: !!p.activity_display,
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
    SELECT tp.*, p.name AS project_name,
           p.token_enabled AS price_enabled,
           p.website, p.github, p.twitter
    FROM token_prices tp
    JOIN projects p ON p.id = tp.project_id AND p.enabled = 1 AND p.user_id = ?
    ORDER BY p.name
  `).all(req.userId);
  res.json(rows.map(r => {
    let website_url = null, github_url = null, twitter_url = null;
    try { website_url = r.website  ? JSON.parse(r.website).url  : null; } catch {}
    try { github_url  = r.github   ? JSON.parse(r.github).url  : null; } catch {}
    try { twitter_url = r.twitter  ? JSON.parse(r.twitter).url : null; } catch {}
    return { ...r, website_url, github_url, twitter_url };
  }));
});

module.exports = router;
