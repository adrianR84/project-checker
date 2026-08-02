/* ── dashboard.js ───────────────────────────────────────────────────────────
   Dashboard REST API — aggregated view

   Route overview (all require session auth):
     GET /                          → DashboardProject[]
     GET /token-prices              → TokenPriceRow[]

   DashboardProject shape:
     { id, name, enabled, activity_display, token, price_enabled,
       website_enabled, website_content_check, github_enabled,
       twitter_enabled, twitter_posts_check, telegram_enabled,
       website_url, github_url, twitter_url, telegram_url,
       created_at, updated_at,
       website_status:  { status, http_status, checked_at } | null,
       github_status:   { status, checked_at } | null,
       twitter_status:  { status, http_status, checked_at } | null,
       website_last_changed_at, github_last_changed_at, twitter_last_changed_at,
       has_unconfirmed: boolean,
       repos: Repo[],       ← active repos
       deletedRepos: Repo[] ← deleted repos }

   Repo shape (github repos only):
     { full_name, repo_url, latest_commit_date, latest_commit_message,
       latest_commit_sha, total_commits, stars_count, language, pushed_at, latest_tag }

   TokenPriceRow shape:
     { project_id, symbol, chain, contract, price_usd,
       price_change_h1, price_change_h6, price_change_h24,
       liquidity_usd, volume_h24, market_cap, pair_created_at, fetched_at,
       project_name, price_enabled, website_url, github_url, twitter_url }

   Internal helpers:
     parseProjectRow(row) → flattened project with JSON cols expanded
────────────────────────────────────────────────────────────────────────── */
// Dashboard REST API — aggregated view
const express = require('express');
const db = require('../services/db');
require('../types'); // JSDoc typedefs only — loaded for editor autocomplete, has no runtime effect

const router = express.Router();

/**
 * Parse a raw project row: expand JSON group cols back to flat names for API compatibility.
 * @param {object|null} row - Raw project DB row
 * @returns {object} Flattened project with website_url, github_url, twitter_url, etc.
 */
function parseProjectRow(row) {
  if (!row) return row;
  /** @type {import('../types').ProjectWebsite} */
  const w = row.website  ? JSON.parse(row.website) : { url: null, cc: 1 };
  /** @type {import('../types').ProjectGithub} */
  const g = row.github   ? JSON.parse(row.github)  : { url: null };
  /** @type {import('../types').ProjectTwitter} */
  const t = row.twitter  ? JSON.parse(row.twitter) : { url: null, pc: 1 };
  /** @type {import('../types').ProjectTelegram} */
  const tg = row.telegram ? JSON.parse(row.telegram) : { url: null };
  return {
    ...row,
    website_url:           w.url,
    website_content_check: w.cc ?? 1,
    github_url:           g.url,
    twitter_url:          t.url,
    twitter_enabled:      row.twitter_enabled,
    twitter_posts_check:  t.pc ?? 1,
    telegram_url:         tg.url,
    price_enabled:        row.token_enabled,
  };
}

// GET /api/dashboard
router.get('/', async (req, res) => {
  const rows = await db.prepare(`
    SELECT id, name, enabled, activity_display, token, token_enabled,
           website, github, twitter, telegram,
           website_enabled, github_enabled, twitter_enabled, telegram_enabled,
           created_at, updated_at, extra_info
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
      twitter_posts_check: !!p.twitter_posts_check,
      telegram_enabled: !!p.telegram_enabled,
      website_url: p.website_url,
      github_url: p.github_url,
      twitter_url: p.twitter_url,
      telegram_url: p.telegram_url || null,
      created_at: p.created_at,
      updated_at: p.updated_at,
      extra_info: p.extra_info ?? null,
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

  // Fetch all snoozes for these projects in one query
  const projectIds = rows.map(r => r.project_id);
  let snoozeRows = [];
  if (projectIds.length) {
    const placeholders = projectIds.map(() => '?').join(',');
    snoozeRows = await db.prepare(
      `SELECT project_id, price_change, snoozed_until FROM token_prices_alerts WHERE project_id IN (${placeholders}) AND snoozed_until IS NOT NULL`
    ).all(...projectIds);
  }

  // Index snoozes by project_id → { [price_change]: snoozed_until }
  const snoozeByProject = {};
  for (const s of snoozeRows) {
    if (!snoozeByProject[s.project_id]) snoozeByProject[s.project_id] = {};
    snoozeByProject[s.project_id][String(s.price_change)] = s.snoozed_until;
  }

  res.json(rows.map(r => {
    let website_url = null, github_url = null, twitter_url = null;
    try { website_url = r.website  ? JSON.parse(r.website).url  : null; } catch {}
    try { github_url  = r.github   ? JSON.parse(r.github).url  : null; } catch {}
    try { twitter_url = r.twitter  ? JSON.parse(r.twitter).url : null; } catch {}
    return { ...r, website_url, github_url, twitter_url, snoozes: snoozeByProject[r.project_id] || {} };
  }));
});

module.exports = router;
